import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseManual,
  loadManual,
  listManuals,
  saveUpload,
  isValidId,
  biteText,
  firstReadable,
  driftRange,
  minutesToChapterEnd,
  MAX_MANUAL_CHARS,
} from "../lib/manual.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_FILE = path.join(here, "..", "manuals", "sample.txt");
const UNDERLINE = /^(\*{3,}|={3,}|-{3,}|\.{3,})$/;

function allBlocks(m) {
  return m.bites.flatMap((b) => b.blocks);
}

test("underlined headings become chapters and their underlines are dropped", () => {
  const m = parseManual("Book Title\n**********\n\nSome words in the intro of the book.\n\nChapter Two\n***********\n\nMore words here.\n");
  assert.deepEqual(m.chapters.map((c) => c.title), ["Book Title", "Chapter Two"]);
  assert.equal(allBlocks(m).some((b) => /\*{3}/.test(b.text)), false);
  assert.equal(m.bites[m.chapters[1].start].blocks[0].type, "h");
});

test("markdown headings: level is the number of hashes", () => {
  const m = parseManual("# One\n\nalpha beta gamma delta epsilon zeta eta.\n\n## Sub\n\ntext here.\n\n# Three\n\ntheta iota kappa lambda mu nu xi.\n");
  assert.deepEqual(m.chapters.map((c) => c.title), ["One", "Three"]);
  assert.ok(allBlocks(m).some((b) => b.type === "h" && b.text === "## Sub"));
});

test("chapter level is the smallest level that occurs at least twice", () => {
  const m = parseManual("Top\n***\n\nintro words.\n\nAlpha\n=====\n\nbody.\n\nBeta\n====\n\nbody.\n");
  assert.deepEqual(m.chapters.map((c) => c.title), ["Front matter", "Alpha", "Beta"]);
});

test("text before the first chapter is front matter", () => {
  const m = parseManual("Contents line one here.\n\nOne\n===\n\nBody words here.\n");
  assert.equal(m.chapters[0].title, "Front matter");
  assert.equal(m.chapters[0].front, true);
  assert.equal(m.chapters[1].front, undefined);
});

test("chapters titled Index or License are front matter", () => {
  const m = parseManual("Body\n****\n\nsome text here for the body.\n\nIndex\n*****\n\n* entry: 1\n");
  assert.equal(m.chapters.find((c) => c.title === "Index").front, true);
});

test("a fenced block with a blank line stays one pre block", () => {
  const m = parseManual("Intro\n=====\n\n```\nline one\n\nline two\n```\n");
  const pre = allBlocks(m).filter((b) => b.type === "pre");
  assert.equal(pre.length, 1);
  assert.equal(pre[0].text, "```\nline one\n\nline two\n```");
});

test("definition pattern gives a pre term and a p description", () => {
  const m = parseManual("Opts\n====\n\n-a\n     Use the a option to print every single entry in the list.\n");
  const blocks = allBlocks(m);
  assert.deepEqual(blocks[1], { type: "pre", text: "-a" });
  assert.equal(blocks[2].type, "p");
  assert.equal(blocks[2].indent, 5);
  assert.match(blocks[2].text, /^Use the a option/);
});

test("uniformly indented prose is reflowed with indent", () => {
  const m = parseManual("Title\n=====\n\n    This is a sentence with plenty of words in it\n    and continues here on the next line too.\n");
  const p = allBlocks(m).find((b) => b.type === "p");
  assert.equal(p.text, "This is a sentence with plenty of words in it and continues here on the next line too.");
  assert.equal(p.indent, 4);
});

test("first-line indent of a paragraph is reflowed as prose", () => {
  const m = parseManual("Title\n=====\n\n   This paragraph starts with an indent and\nthen has flush lines that follow on.\n");
  const p = allBlocks(m).find((b) => b.type === "p");
  assert.equal(p.indent, 0);
  assert.equal(p.text, "This paragraph starts with an indent and then has flush lines that follow on.");
});

test("indented command lines stay pre", () => {
  const m = parseManual("Title\n=====\n\n    $ npm test --watch\n    $ npm run build\n");
  const b = allBlocks(m).find((x) => x.type !== "h");
  assert.equal(b.type, "pre");
  assert.equal(b.text, "    $ npm test --watch\n    $ npm run build");
});

test("no bite crosses a chapter and no bite ends on a heading", () => {
  let src = "";
  for (let c = 0; c < 6; c++) {
    src += `Chapter ${c}\n==========\n\n`;
    for (let p = 0; p < 9; p++) {
      src += "This is paragraph number " + p + " of chapter " + c + " with some extra words to fill it up.\n\n";
    }
    src += `Tail heading ${c}\n------------\n\nA closing paragraph after the heading.\n\n`;
  }
  const m = parseManual(src);
  m.chapters.forEach((ch, ci) => {
    for (let i = ch.start; i <= ch.end; i++) {
      assert.equal(m.bites[i].chapter, ci);
    }
    assert.notEqual(m.bites[ch.end].blocks.at(-1).type, "h");
  });
});

test("repeat runs are deep-equal", () => {
  const text = fs.readFileSync(SAMPLE_FILE, "utf8");
  assert.deepEqual(parseManual(text), parseManual(text));
});

test("no text is lost (underline lines aside)", () => {
  const text = fs.readFileSync(SAMPLE_FILE, "utf8");
  const kept = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !UNDERLINE.test(l.trim()))
    .join("\n");
  const m = parseManual(text);
  const squash = (s) => s.replace(/\s+/g, "");
  const got = m.bites.flatMap((b) => b.blocks.map((bl) => bl.text)).join("\n");
  assert.equal(squash(got), squash(kept));
});

test("a 400-word paragraph is split at sentence ends", () => {
  const sentences = [];
  for (let i = 0; i < 40; i++) sentences.push("alpha beta gamma delta epsilon zeta eta theta iota kappa.");
  const m = parseManual("Title\n=====\n\n" + sentences.join("\n") + "\n");
  const ps = allBlocks(m).filter((b) => b.type === "p");
  assert.ok(ps.length >= 2);
  for (const p of ps) {
    assert.ok(p.text.split(/\s+/).length <= 220);
    assert.ok(p.text.endsWith("kappa."));
  }
});

test("real sample: structure", () => {
  const m = loadManual("sample", path.join(here, ".."));
  const real = m.chapters.filter((c) => c.front !== true);
  assert.ok(real.length >= 5);
  assert.equal(m.chapters[0].title, "Front matter");
  assert.equal(m.chapters[0].front, true);
  assert.ok(m.bites.every((b) => b.words > 0 && b.blocks.length > 0));
  const words = m.bites.map((b) => b.words).sort((a, b) => a - b);
  const median = words[Math.floor(words.length / 2)];
  assert.ok(median >= 60 && median <= 300, `median ${median}`);
});

test("real sample: at least half of non-heading blocks in real chapters are paragraphs", () => {
  // Measured 54.6% with the rules as written; prose blocks mixed with indented examples fall to pre.
  const m = loadManual("sample", path.join(here, ".."));
  let total = 0;
  let prose = 0;
  for (const b of m.bites) {
    if (m.chapters[b.chapter].front) continue;
    for (const bl of b.blocks) {
      if (bl.type === "h") continue;
      total++;
      if (bl.type === "p") prose++;
    }
  }
  assert.ok(prose / total >= 0.5, `paragraph share ${(prose / total).toFixed(3)}`);
});

test("driftRange", () => {
  assert.deepEqual(driftRange(12, 5), { from: 8, to: 12 });
  assert.deepEqual(driftRange(2, 10), { from: 0, to: 2 });
  assert.throws(() => driftRange(5, 7));
});

test("isValidId", () => {
  for (const bad of ["../etc/passwd", "..%2F..", "a/b", "", "x".repeat(200)]) {
    assert.equal(isValidId(bad), false, bad);
  }
  assert.equal(isValidId("sample"), true);
  assert.equal(isValidId("u-0123456789abcdef"), true);
});

test("saveUpload, listManuals and loadManual use only the temp dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
  const id = saveUpload({ title: "my notes.txt", text: "Heading\n=======\n\nSome words in a paragraph of the upload here.\n" }, dir);
  assert.match(id, /^u-[a-f0-9]{16}$/);
  assert.ok(fs.existsSync(path.join(dir, "uploads", id + ".json")));
  const list = listManuals(dir);
  assert.equal(list[0].id, "sample");
  assert.ok(list.some((x) => x.id === id && x.title === "my notes"));
  const m = loadManual(id, dir);
  assert.equal(m.title, "my notes");
  assert.equal(m.chapters[0].title, "Heading");
});

test("saveUpload rejects empty and oversized text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
  assert.throws(() => saveUpload({ title: "x", text: "   \n\t" }, dir), (e) => e.code === "empty");
  assert.throws(() => saveUpload({ title: "x", text: "a".repeat(MAX_MANUAL_CHARS + 1) }, dir), (e) => e.code === "too_large");
  assert.throws(() => saveUpload({ title: "x", text: 5 }, dir), (e) => e.code === "empty");
  assert.throws(() => saveUpload(null, dir), (e) => e.code === "empty");
});

test("loadManual rejects bad ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
  assert.throws(() => loadManual("../x", dir), (e) => e.code === "bad_id");
});

test("biteText, firstReadable and minutesToChapterEnd", () => {
  const m = parseManual("Front\n\nsome front words here in the contents list.\n\nOne\n===\n\n" + "word ".repeat(300) + "\n");
  assert.equal(firstReadable(m), m.chapters[1].start);
  assert.equal(biteText(m.bites[m.chapters[1].start]).startsWith("One"), true);
  assert.equal(minutesToChapterEnd(m, m.chapters[1].start, 200), Math.ceil(m.bites[m.chapters[1].start].words / 200));
});
