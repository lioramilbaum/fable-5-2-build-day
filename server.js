import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  listManuals,
  loadManual,
  saveUpload,
  isValidId,
} from "./lib/manual.js";
import {
  makeClientFactory,
  streamAsk,
  complete,
  buildAskRequest,
  buildWarmRequest,
  buildGameRequest,
} from "./lib/claude.js";
import { chapterPlayable, gameInstruction, parseGame } from "./lib/game.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const STATIC = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/focus.js": ["public/focus.js", "text/javascript; charset=utf-8"],
  "/style.css": ["public/style.css", "text/css; charset=utf-8"],
  "/game.js": ["public/game.js", "text/javascript; charset=utf-8"],
  "/game-logic.js": ["public/game-logic.js", "text/javascript; charset=utf-8"],
  "/game.css": ["public/game.css", "text/css; charset=utf-8"],
};

const ASK_BODY_CAP = 16 * 1024;
const UPLOAD_BODY_CAP = 4 * 1024 * 1024;
const TASKS = ["drift", "where", "what"];
const RANGES = [3, 5, 10];

const SIGN_IN_MESSAGE =
  "Drift couldn't sign in to Claude. Set ANTHROPIC_API_KEY and restart. Reading still works.";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isSignInError(err) {
  if (err instanceof Anthropic.AuthenticationError) return true;
  if (err instanceof Anthropic.APIError) return false;
  return /api[ _-]?key|auth|credential/i.test(String(err?.message ?? ""));
}

function errorMessageFor(err) {
  if (isSignInError(err)) return SIGN_IN_MESSAGE;
  if (err instanceof Anthropic.APIError) {
    return err.status
      ? `Claude had a problem (status ${err.status}). Try again.`
      : "Claude had a problem. Try again.";
  }
  return "Something went wrong. Try again.";
}

// Log fields only: never the manual or credentials. API messages are cut to 300 characters and keys are redacted.
function logErrorKind(err) {
  if (err instanceof Anthropic.APIError) {
    const message = String(err.message ?? "")
      .replace(/sk-[A-Za-z0-9_-]+/g, "[key]")
      .slice(0, 300);
    return `status=${err.status} message=${JSON.stringify(message)}`;
  }
  return `error=${err?.name ?? "Error"}`;
}

function pickUsage(u = {}) {
  return {
    input_tokens: u.input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
  };
}

// Past the cap the rest of the body is drained without buffering, so the client still gets its 413.
// A body that goes on past four times the cap is cut off.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (tooLarge) {
        if (size > limit * 4) req.destroy();
        return;
      }
      if (size > limit) {
        tooLarge = true;
        reject(new HttpError(413, "That's too large for Drift."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJson(req, limit) {
  const text = await readBody(req, limit);
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new HttpError(400, "Expected a JSON object.");
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

// Loads a manual by id, mapping failures to HTTP errors.
async function findManual(id, dataDir) {
  if (!isValidId(id)) throw new HttpError(400, "That manual id isn't valid.");
  try {
    return await loadManual(id, dataDir);
  } catch (err) {
    if (err?.code === "bad_id") throw new HttpError(400, "That manual id isn't valid.");
    if (err?.code === "not_found") throw new HttpError(404, "That manual doesn't exist.");
    throw err;
  }
}

export function createApp({ getClient, dataDir }) {
  const games = new Map();

  async function handleAsk(req, res) {
    const input = await readJson(req, ASK_BODY_CAP);
    const { task } = input;
    if (!TASKS.includes(task)) throw new HttpError(400, "Unknown task.");

    const manual = await findManual(input.manualId, dataDir).catch((err) => {
      if (err instanceof HttpError) throw new HttpError(400, "That manual isn't available.");
      throw err;
    });

    const { position } = input;
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position > manual.bites.length - 1
    ) {
      throw new HttpError(400, "That position isn't in this manual.");
    }

    let range;
    if (task === "drift") {
      if (!RANGES.includes(input.range)) throw new HttpError(400, "Range must be 3, 5 or 10.");
      range = input.range;
    }

    let term;
    if (task === "what") {
      if (typeof input.term !== "string") throw new HttpError(400, "Term is required.");
      term = input.term.replace(/[\r\n<>]/g, "").trim();
      if (term.length < 1 || term.length > 80) {
        throw new HttpError(400, "Term must be 1 to 80 characters.");
      }
    }

    const body = buildAskRequest(manual, { task, position, range, term });

    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
    });
    res.flushHeaders();

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    const line = (value) => {
      if (!res.destroyed) res.write(`${JSON.stringify(value)}\n`);
    };

    let result;
    try {
      result = await streamAsk({
        getClient,
        body,
        signal: controller.signal,
        onText: (text) => line({ type: "chunk", text }),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        console.log(`[ask] task=${task} model=${body.model} stop=aborted`);
      } else {
        console.log(`[ask] task=${task} model=${body.model} stop=error ${logErrorKind(err)}`);
        line({ type: "error", message: errorMessageFor(err) });
      }
      res.end();
      return;
    }

    const usage = pickUsage(result.usage);
    console.log(
      `[ask] task=${task} model=${body.model} in=${usage.input_tokens} cache_read=${usage.cache_read_input_tokens} cache_write=${usage.cache_creation_input_tokens} out=${usage.output_tokens} ms=${result.ms} stop=${result.stop_reason}`,
    );

    if (result.stop_reason === "refusal") {
      line({
        type: "refusal",
        message: "Claude couldn't help with this part. Try a different range, or just keep reading.",
      });
    } else {
      const done = { type: "done", usage, ms: result.ms };
      if (result.stop_reason === "max_tokens") done.note = "(Cut short.)";
      line(done);
    }
    res.end();
  }

  async function handleWarm(req, res) {
    // Always 204: a warm-up must never affect the reader.
    try {
      const input = await readJson(req, ASK_BODY_CAP);
      const manual = await findManual(input.manualId, dataDir);
      complete({ getClient, body: buildWarmRequest(manual) })
        .then((r) => {
          const u = pickUsage(r.usage);
          console.log(
            `[warm] cache_read=${u.cache_read_input_tokens} cache_write=${u.cache_creation_input_tokens} ms=${r.ms} stop=${r.stop_reason}`,
          );
        })
        .catch((err) => {
          console.log(`[warm] failed ${logErrorKind(err)}`);
        });
    } catch {
      // Ignore bad input; still answer 204.
    }
    res.writeHead(204);
    res.end();
  }

  async function makeGame(manual, chapter) {
    const body = buildGameRequest(manual, chapter, gameInstruction(manual, chapter));
    const result = await complete({ getClient, body });
    const u = pickUsage(result.usage);
    console.log(
      `[game] chapter=${chapter} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens} cache_write=${u.cache_creation_input_tokens} out=${u.output_tokens} ms=${result.ms}`,
    );
    if (result.stop_reason === "refusal") {
      throw new HttpError(
        502,
        "Claude couldn't make a game for this chapter. Keep reading; the next chapter will have one.",
      );
    }
    if (result.stop_reason === "max_tokens") {
      throw new HttpError(502, "The game for this chapter didn't come out right. Keep reading.");
    }
    const parsed = parseGame(result.text, manual, chapter);
    if (!parsed.ok) {
      throw new HttpError(502, "The game for this chapter didn't come out right. Keep reading.");
    }
    return { game: parsed.game };
  }

  async function handleGame(req, res) {
    const input = await readJson(req, ASK_BODY_CAP);
    const manual = await findManual(input.manualId, dataDir);
    const { chapter } = input;
    if (
      !Number.isInteger(chapter) ||
      chapter < 0 ||
      chapter > manual.chapters.length - 1
    ) {
      throw new HttpError(400, "That chapter isn't in this manual.");
    }

    if (!chapterPlayable(manual, chapter)) {
      throw new HttpError(400, "This chapter doesn't have a game.");
    }

    const key = `${input.manualId}:${chapter}`;
    if (!games.has(key)) {
      const pending = makeGame(manual, chapter);
      games.set(key, pending);
      // Failures are not memoised, so a later request can try again.
      pending.catch(() => games.delete(key));
    }
    try {
      sendJson(res, 200, await games.get(key));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.log(`[game] failed ${logErrorKind(err)}`);
      if (isSignInError(err)) throw new HttpError(502, SIGN_IN_MESSAGE);
      throw new HttpError(502, "Something went wrong. Try again.");
    }
  }

  async function handleUpload(req, res) {
    const text = await readBody(req, UPLOAD_BODY_CAP);
    let input;
    try {
      input = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Expected a JSON object.");
    }
    const validShape =
      input !== null &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      typeof input.text === "string" &&
      (input.title === undefined || typeof input.title === "string");
    if (!validShape) {
      throw new HttpError(400, "Send the manual's text, and optionally a title.");
    }
    try {
      const id = await saveUpload(input, dataDir);
      sendJson(res, 200, { id });
    } catch (err) {
      if (err?.code === "too_large") {
        throw new HttpError(
          413,
          "This manual is too long for Drift (about 1.5 million characters max). Try uploading it in parts.",
        );
      }
      if (err?.code === "empty") throw new HttpError(400, "That manual is empty.");
      throw new HttpError(400, "Drift couldn't save that manual. Check the text and try again.");
    }
  }

  async function handleApi(req, res, pathname) {
    if (pathname === "/api/manuals" && req.method === "GET") {
      return sendJson(res, 200, await listManuals(dataDir));
    }
    if (pathname === "/api/manuals" && req.method === "POST") {
      return handleUpload(req, res);
    }
    const match = /^\/api\/manuals\/([^/]+)$/.exec(pathname);
    if (match && req.method === "GET") {
      let id;
      try {
        id = decodeURIComponent(match[1]);
      } catch {
        throw new HttpError(400, "That manual id isn't valid.");
      }
      return sendJson(res, 200, await findManual(id, dataDir));
    }
    if (pathname === "/api/ask" && req.method === "POST") return handleAsk(req, res);
    if (pathname === "/api/warm" && req.method === "POST") return handleWarm(req, res);
    if (pathname === "/api/game" && req.method === "POST") return handleGame(req, res);
    throw new HttpError(404, "Not found.");
  }

  async function handleStatic(res, pathname) {
    const entry = STATIC[pathname];
    if (!entry) throw new HttpError(404, "Not found.");
    let data;
    try {
      data = await fs.readFile(path.join(here, entry[0]));
    } catch (err) {
      if (err?.code === "ENOENT") throw new HttpError(404, "Not found.");
      throw err;
    }
    res.writeHead(200, { "content-type": entry[1] });
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const pathname = new URL(req.url, "http://localhost").pathname;
    try {
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname);
      } else {
        await handleStatic(res, pathname);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) return sendJson(res, err.status, { error: err.message });
        return res.end();
      }
      console.log(`[server] unexpected ${err?.name ?? "Error"}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong. Try again." });
      else res.end();
    }
  });
  return server;
}

if (import.meta.main) {
  const port = Number(process.env.PORT || 3000);
  const dataDir = process.env.DRIFT_DATA_DIR || path.join(here, "data");
  const server = createApp({ getClient: makeClientFactory(), dataDir });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Drift on http://127.0.0.1:${port}`);
  });
}
