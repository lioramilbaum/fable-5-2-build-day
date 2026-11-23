import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createApp } from "../server.js";
import { makeClientFactory } from "../lib/claude.js";
import { SAMPLE_ID } from "../lib/manual.js";

const STREAM_TEXT = ["Use the ", "install ", "command."];

function gameJson() {
  const quiz = [0, 1, 2].map((i) => ({
    question: `Question ${i}?`,
    options: [`A${i}`, `B${i}`, `C${i}`],
    answer: i,
    quote: "Some words from the chapter.",
    bite: 1,
  }));
  const truefalse = [0, 1, 2, 3, 4].map((i) => ({
    statement: `Statement ${i}.`,
    answer: i % 2 === 0,
    quote: "Some words from the chapter.",
    bite: 1,
  }));
  return JSON.stringify({ quiz, truefalse, order: null });
}

function sse(res, events) {
  for (const [name, data] of events) {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

function streamEvents(mode, model) {
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 900,
            output_tokens: 1,
          },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ];
  if (mode === "midError") {
    events.push([
      "error",
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ]);
    return events;
  }
  events.push([
    "content_block_start",
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  ]);
  for (const text of STREAM_TEXT) {
    events.push([
      "content_block_delta",
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
    ]);
  }
  events.push(["content_block_stop", { type: "content_block_stop", index: 1 }]);
  events.push([
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: mode === "refusal" ? "refusal" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 7 },
    },
  ]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events;
}

function plainMessage(text, stop_reason = "end_turn") {
  return {
    id: "msg_2",
    type: "message",
    role: "assistant",
    model: "claude-fable-5-2",
    content: text === null ? [] : [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

// Stub upstream. state.mode picks the reply: ok | refusal | midError | status400 | game | garbage.
async function startStub() {
  const state = { mode: "ok", requests: [], gameText: gameJson() };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      state.requests.push({ url: req.url, headers: req.headers, body });
      if (state.mode === "status400") {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }));
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return sse(res, streamEvents(state.mode, body.model));
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (body.max_tokens === 0) return res.end(JSON.stringify(plainMessage(null, "max_tokens")));
      if (state.mode === "refusal") return res.end(JSON.stringify(plainMessage(null, "refusal")));
      if (state.mode === "game") return res.end(JSON.stringify(plainMessage(state.gameText)));
      if (state.mode === "garbage") return res.end(JSON.stringify(plainMessage("not json at all")));
      return res.end(JSON.stringify(plainMessage("ok")));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    state,
    requests: state.requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

async function setup(t, { getClient } = {}) {
  const stub = await startStub();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-server-test-"));
  const app = createApp({
    getClient: getClient ?? makeClientFactory({ apiKey: "test", baseURL: stub.url, maxRetries: 0 }),
    dataDir,
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
    await stub.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { base, stub, dataDir, stubState: stub.state };
}

function post(base, route, body) {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function ndjson(res) {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("ask on the sample streams the text with no thinking content", async (t) => {
  const { base, stub } = await setup(t);
  const res = await post(base, "/api/ask", { manualId: SAMPLE_ID, task: "where", position: 0 });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/x-ndjson/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'self'");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const lines = await ndjson(res);
  const chunks = lines.filter((l) => l.type === "chunk").map((l) => l.text);
  assert.equal(chunks.join(""), STREAM_TEXT.join(""));
  const done = lines.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.usage.cache_read_input_tokens, 900);
  assert.equal(lines.filter((l) => l.type === "done").length, 1);

  const upstream = stub.requests.find((r) => r.body.stream);
  assert.ok(upstream, "upstream stream request recorded");
  const first = upstream.body.messages[0].content[0];
  assert.match(first.text, /<manual title="GNU Bash Reference Manual">/);
  assert.deepEqual(first.cache_control, { type: "ephemeral", ttl: "1h" });
});

test("stub refusal produces a refusal line and no done line", async (t) => {
  const { base, stubState } = await setup(t);
  stubState.mode = "refusal";
  const res = await post(base, "/api/ask", { manualId: SAMPLE_ID, task: "where", position: 0 });
  const lines = await ndjson(res);
  const terminal = lines.filter((l) => l.type !== "chunk");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, "refusal");
  assert.equal(terminal[0].message, "Claude couldn't help with this part. Try a different range, or just keep reading.");
});

test("mid-stream error event produces an error line", async (t) => {
  const { base, stubState } = await setup(t);
  stubState.mode = "midError";
  const res = await post(base, "/api/ask", { manualId: SAMPLE_ID, task: "where", position: 0 });
  const lines = await ndjson(res);
  const last = lines.at(-1);
  assert.equal(last.type, "error");
  assert.equal(lines.filter((l) => l.type === "done").length, 0);
});

test("a getClient that throws gives the sign-in line; reading still works", async (t) => {
  const { base } = await setup(t, {
    getClient: () => {
      throw new Error("no credentials");
    },
  });
  const res = await post(base, "/api/ask", { manualId: SAMPLE_ID, task: "where", position: 0 });
  const lines = await ndjson(res);
  assert.deepEqual(lines, [
    { type: "error", message: "Drift couldn't sign in to Claude. Set ANTHROPIC_API_KEY and restart. Reading still works." },
  ]);
  const manual = await fetch(`${base}/api/manuals/${SAMPLE_ID}`);
  assert.equal(manual.status, 200);
});

test("bad ask requests are rejected with 400 before any upstream call", async (t) => {
  const { base, stub } = await setup(t);
  const manual = await (await fetch(`${base}/api/manuals/${SAMPLE_ID}`)).json();
  const last = manual.bites.length;
  const cases = [
    { manualId: SAMPLE_ID, task: "nope", position: 0 },
    { manualId: SAMPLE_ID, task: "where", position: -1 },
    { manualId: SAMPLE_ID, task: "where", position: last },
    { manualId: SAMPLE_ID, task: "drift", position: 0, range: 7 },
    { manualId: SAMPLE_ID, task: "what", position: 0, term: "   " },
    { manualId: SAMPLE_ID, task: "what", position: 0, term: "<>\n" },
    { manualId: "../../etc/passwd", task: "where", position: 0 },
  ];
  for (const body of cases) {
    const res = await post(base, "/api/ask", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error);
  }
  assert.equal(stub.requests.length, 0);
});

test("GET with an encoded traversal id is 400 and leaks nothing", async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/api/manuals/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes("root:"));
});

test("upload stores under the temp data dir and returns an id", async (t) => {
  const { base, dataDir } = await setup(t);
  const res = await post(base, "/api/manuals", { title: "Small", text: "Chapter one\n\nSome words here.\n" });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.ok(id);
  const files = fs.readdirSync(path.join(dataDir, "uploads"));
  assert.ok(files.length >= 1, "upload written under the temp dir");
  const back = await fetch(`${base}/api/manuals/${id}`);
  assert.equal(back.status, 200);
});

test("upload over the cap is 413", async (t) => {
  const { base } = await setup(t);
  const text = "a".repeat(1_600_000);
  const res = await post(base, "/api/manuals", { title: "Big", text });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too long for Drift/);
});

test("upload body past the 4 MB cap still gets 413", async (t) => {
  const { base } = await setup(t);
  const res = await post(base, "/api/manuals", { title: "Huge", text: "a".repeat(4_200_000) });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large for Drift/);
});

test("upload with a non-object body or non-string text or title is 400", async (t) => {
  const { base } = await setup(t);
  const cases = [[1, 2], { text: 5 }, { text: "Some words here.", title: 7 }];
  for (const body of cases) {
    const res = await post(base, "/api/manuals", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, "Send the manual's text, and optionally a title.");
  }
});

test("warm always answers 204, even when the upstream answers 400", async (t) => {
  const { base, stub, stubState } = await setup(t);
  stubState.mode = "status400";
  const res = await post(base, "/api/warm", { manualId: SAMPLE_ID });
  assert.equal(res.status, 204);
  const deadline = Date.now() + 2000;
  while (stub.requests.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const warm = stub.requests.at(-1);
  assert.equal(warm.body.max_tokens, 0);
  assert.equal(warm.body.stream, undefined);
});

test("game: valid reply gives 200 and is memoised", async (t) => {
  const { base, stub, stubState } = await setup(t);
  const { chapterIndex } = await playableChapter();
  stubState.mode = "game";
  const body = { manualId: SAMPLE_ID, chapter: chapterIndex };
  const first = await post(base, "/api/game", body);
  assert.equal(first.status, 200);
  const { game } = await first.json();
  assert.equal(game.chapter, chapterIndex);
  assert.equal(game.quiz.length, 3);
  const count = stub.requests.length;
  const second = await post(base, "/api/game", body);
  assert.equal(second.status, 200);
  assert.equal(stub.requests.length, count, "second call does not reach the stub");
});

test("game: garbage reply gives 502 and is not memoised", async (t) => {
  const { base, stub, stubState } = await setup(t);
  const { chapterIndex } = await playableChapter();
  stubState.mode = "garbage";
  const body = { manualId: SAMPLE_ID, chapter: chapterIndex };
  const res = await post(base, "/api/game", body);
  assert.equal(res.status, 502);
  assert.ok((await res.json()).error);
  const count = stub.requests.length;
  stubState.mode = "game";
  const retry = await post(base, "/api/game", body);
  assert.equal(retry.status, 200);
  assert.ok(stub.requests.length > count, "failure was not memoised");
});

test("game: out-of-range chapter gives 400", async (t) => {
  const { base } = await setup(t);
  const manual = await (await fetch(`${base}/api/manuals/${SAMPLE_ID}`)).json();
  const res = await post(base, "/api/game", { manualId: SAMPLE_ID, chapter: manual.chapters.length });
  assert.equal(res.status, 400);
});

async function playableChapter() {
  const { loadManual } = await import("../lib/manual.js");
  const { chapterPlayable } = await import("../lib/game.js");
  const manual = loadManual(SAMPLE_ID, os.tmpdir());
  const chapterIndex = manual.chapters.findIndex((_, i) => chapterPlayable(manual, i));
  return { chapterIndex };
}
