import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const SAMPLE_ID = "sample";
export const MAX_MANUAL_CHARS = 1_500_000;
export const SAMPLE_TITLE = "GNU Bash Reference Manual";

const SAMPLE_PATH = fileURLToPath(new URL("../manuals/sample.txt", import.meta.url));
const ID_RE = /^(sample|u-[a-f0-9]{16})$/;
const UNDERLINE_RE = /^(\*{3,}|={3,}|-{3,}|\.{3,})$/;
const MD_RE = /^(#{1,6})[ \t]+(.*\S)\s*$/;
const UPLOAD_FILE_RE = /^u-[a-f0-9]{16}\.json$/;
const FRONT_RE = /\b(index|indexes|contents|license)\b/i;
const LEVEL = { "*": 1, "=": 2, "-": 3, ".": 4 };
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

const cache = new Map();

function coded(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

// Indentation in columns; a tab counts as 8.
function leadingSpaces(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 8;
    else break;
  }
  return n;
}

// Splits the source into heading items and runs of raw lines (blocks).
function scan(lines) {
  const items = [];
  let run = [];
  const flush = () => {
    if (run.length) items.push({ kind: "block", lines: run });
    run = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const fenced = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i++];
        fenced.push(l);
        if (l.trim().startsWith(marker)) break;
      }
      items.push({ kind: "block", lines: fenced, fenced: true });
      continue;
    }
    const title = line.trim();
    const next = lines[i + 1];
    const nextTrim = next === undefined ? "" : next.trim();
    if (
      UNDERLINE_RE.test(nextTrim) &&
      Math.abs(nextTrim.length - title.length) <= 3
    ) {
      flush();
      items.push({ kind: "heading", level: LEVEL[nextTrim[0]], title, text: title });
      i += 2;
      continue;
    }
    const md = MD_RE.exec(line);
    if (md) {
      flush();
      items.push({ kind: "heading", level: md[1].length, title: md[2].trim(), text: title });
      i++;
      continue;
    }
    run.push(line);
    i++;
  }
  flush();
  return items;
}

// "Looks like prose": at least 6 words, at least 70% letters, no list or prompt marker.
function looksLikeProse(lines) {
  const text = lines.map((l) => l.trim()).join(" ");
  const first = lines[0].trim();
  if (/^([-*+$#>|]|\d+[.)])/.test(first)) return false;
  if (wordCount(text) < 6) return false;
  const chars = text.replace(/\s/g, "");
  const letters = (chars.match(/\p{L}/gu) || []).length;
  return letters >= 0.7 * chars.length;
}

function pre(lines) {
  return { type: "pre", text: lines.join("\n") };
}

function para(lines, indent) {
  return { type: "p", text: lines.map((l) => l.trim()).join(" "), indent };
}

function classifyLines(lines) {
  const ind = lines.map(leadingSpaces);
  const rest = ind.slice(1);
  const restUniform = rest.length > 0 && rest.every((v) => v === rest[0]);
  if (ind.every((v) => v === ind[0])) {
    if (lines.length === 1 && ind[0] >= 1 && ind[0] <= 4) {
      // A one-line paragraph with a Texinfo-style first-line indent: no remaining lines, so indent 0.
      return [looksLikeProse(lines) ? para(lines, 0) : pre(lines)];
    }
    return [looksLikeProse(lines) ? para(lines, ind[0]) : pre(lines)];
  }
  if (restUniform && ind[0] < rest[0]) {
    // Definition: a term line, then an indented description.
    return [pre([lines[0]]), ...classifyLines(lines.slice(1))];
  }
  if (restUniform && ind[0] - rest[0] >= 1 && ind[0] - rest[0] <= 4) {
    // Ordinary paragraph: first line indented 1 to 4 more than the rest.
    return [looksLikeProse(lines) ? para(lines, rest[0]) : pre(lines)];
  }
  return [pre(lines)];
}

function splitProse(b) {
  const sentences = b.text.split(/(?<=[.!?])\s+/);
  const out = [];
  let acc = [];
  let n = 0;
  const emit = () => {
    const text = acc.join(" ");
    out.push({ type: "p", text, indent: b.indent, section: b.section, words: wordCount(text) });
    acc = [];
    n = 0;
  };
  for (const s of sentences) {
    acc.push(s);
    n += wordCount(s);
    if (n >= 150) emit();
  }
  if (acc.length) emit();
  return out;
}

function buildBites(blocks) {
  const pieces = [];
  for (const b of blocks) {
    if (b.type === "p" && b.words > 220) pieces.push(...splitProse(b));
    else pieces.push(b);
  }
  const bites = [];
  let cur = [];
  let n = 0;
  for (const b of pieces) {
    cur.push(b);
    n += b.words;
    if (n >= 120 && b.type !== "h") {
      bites.push(cur);
      cur = [];
      n = 0;
    }
  }
  if (cur.length) bites.push(cur);
  if (bites.length > 1) {
    const last = bites[bites.length - 1];
    const lastWords = last.reduce((s, b) => s + b.words, 0);
    if (lastWords < 40 || last[last.length - 1].type === "h") {
      bites[bites.length - 2].push(...last);
      bites.pop();
    }
  }
  return bites;
}

function outBlock(b) {
  return b.type === "p" ? { type: "p", text: b.text, indent: b.indent } : { type: b.type, text: b.text };
}

export function parseManual(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const items = scan(lines);
  const headings = items.filter((it) => it.kind === "heading");

  // Each group: { title, front?, head?, items, preface? }
  const groups = [];
  if (!headings.length) {
    groups.push({ title: "Manual", items });
  } else {
    const counts = new Map();
    for (const h of headings) counts.set(h.level, (counts.get(h.level) || 0) + 1);
    const levels = [...counts.keys()].sort((a, b) => a - b);
    const chapterLevel = levels.find((l) => counts.get(l) >= 2) ?? levels[0];
    const preface = [];
    let cur = null;
    for (const it of items) {
      if (it.kind === "heading" && it.level === chapterLevel) {
        cur = { title: it.title, head: it, items: [] };
        groups.push(cur);
      } else if (cur) {
        cur.items.push(it);
      } else {
        preface.push(it);
      }
    }
    if (preface.length) {
      groups.unshift({ title: "Front matter", preface: true, items: preface });
    }
  }

  const chapters = [];
  const bites = [];
  for (const g of groups) {
    const blocks = [];
    let section = null;
    if (g.head) {
      section = g.head.title;
      blocks.push({ type: "h", text: g.head.text, section, words: wordCount(g.head.text) });
    }
    for (const it of g.items) {
      if (it.kind === "heading") {
        section = it.title;
        blocks.push({ type: "h", text: it.text, section, words: wordCount(it.text) });
      } else {
        const parts = it.fenced ? [pre(it.lines)] : classifyLines(it.lines);
        for (const p of parts) blocks.push({ ...p, section, words: wordCount(p.text) });
      }
    }
    const grouped = buildBites(blocks);
    if (!grouped.length) continue;
    const ci = chapters.length;
    const start = bites.length;
    for (const bl of grouped) {
      bites.push({
        chapter: ci,
        words: bl.reduce((s, b) => s + b.words, 0),
        section: bl[0].section,
        blocks: bl.map(outBlock),
      });
    }
    const chapter = { title: g.title, start, end: bites.length - 1 };
    if (g.preface || FRONT_RE.test(g.title)) chapter.front = true;
    chapters.push(chapter);
  }
  return { chapters, bites };
}

export function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

export function loadManual(id, dataDir) {
  if (!isValidId(id)) throw coded("bad_id");
  let file;
  if (id === SAMPLE_ID) {
    file = SAMPLE_PATH;
  } else {
    const base = path.resolve(dataDir, "uploads");
    file = path.resolve(base, id + ".json");
    if (!file.startsWith(base + path.sep)) throw coded("bad_id");
  }
  if (cache.has(file)) return cache.get(file);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw coded("not_found");
    throw err;
  }
  let manual;
  if (id === SAMPLE_ID) {
    manual = { id, title: SAMPLE_TITLE, ...parseManual(raw) };
  } else {
    const data = JSON.parse(raw);
    manual = { id, title: data.title, ...parseManual(data.text) };
  }
  cache.set(file, manual);
  return manual;
}

export function listManuals(dataDir) {
  const out = [{ id: SAMPLE_ID, title: SAMPLE_TITLE }];
  const dir = path.resolve(dataDir, "uploads");
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const name of names.filter((n) => UPLOAD_FILE_RE.test(n)).sort()) {
    try {
      const data = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      out.push({ id: name.slice(0, -5), title: String(data.title ?? name) });
    } catch {
      // skip unreadable upload
    }
  }
  return out;
}

function cleanTitle(t) {
  const base = String(t ?? "").split(/[\\/]/).pop();
  return base.replace(/\.(txt|md)$/i, "").replace(CONTROL_RE, "").trim().slice(0, 100).trim();
}

function firstLine(text) {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(CONTROL_RE, "").trim())
    .find(Boolean);
  return (line || "").slice(0, 100);
}

export function saveUpload(input, dataDir) {
  const { title, text } = input ?? {};
  if (typeof text !== "string" || text.trim() === "") throw coded("empty");
  if (text.length > MAX_MANUAL_CHARS) throw coded("too_large");
  const id = "u-" + createHash("sha256").update(text).digest("hex").slice(0, 16);
  const name = cleanTitle(title) || firstLine(text) || "Untitled manual";
  const dir = path.resolve(dataDir, "uploads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.resolve(dir, id + ".json"), JSON.stringify({ title: name, text }));
  return id;
}

export function biteText(bite) {
  return bite.blocks.map((b) => b.text).join("\n\n");
}

export function firstReadable(manual) {
  const ch = manual.chapters.find((c) => c.front !== true);
  return ch ? ch.start : 0;
}

export function driftRange(position, k) {
  if (![3, 5, 10].includes(k)) throw new Error("k must be 3, 5 or 10");
  return { from: Math.max(0, position - k + 1), to: position };
}

export function minutesToChapterEnd(manual, i, wpm = 200) {
  const ch = manual.chapters.find((c) => c.start <= i && i <= c.end);
  const end = ch ? ch.end : i;
  let words = 0;
  for (let j = i; j <= end; j++) words += manual.bites[j].words;
  return Math.ceil(words / wpm);
}
