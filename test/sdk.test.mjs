import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  __resetForTests,
  addBreadcrumb,
  captureException,
  captureMessage,
  clearBreadcrumbs,
  close,
  flush,
  init,
  setUser,
  wrap,
} from "../dist/index.js";

function startCaptureServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      handler?.(req, res, body);
      if (!res.writableEnded) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end('{"success":true}');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

test("init requires an api key", () => {
  __resetForTests();
  assert.throws(() => init({ apiKey: "" }), /apiKey/);
});

test("captureMessage posts X-API-Key + EventInput shape", async () => {
  __resetForTests();
  const { server, requests, port } = await startCaptureServer();
  try {
    init({
      apiKey: "test-key",
      endpoint: `http://127.0.0.1:${port}`,
      environment: "production",
      service: "payment-api",
    });
    await captureMessage("boom", { level: "fatal", metadata: { a: 1 } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/v1/events/");
    assert.equal(requests[0].headers["x-api-key"], "test-key");
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.message, "boom");
    assert.equal(payload.level, "fatal");
    assert.equal(payload.environment, "production");
    assert.equal(payload.service, "payment-api");
    assert.deepEqual(payload.metadata, { a: 1 });
  } finally {
    server.close();
  }
});

test("captureException extracts message + stack, defaults level error", async () => {
  __resetForTests();
  const { server, requests, port } = await startCaptureServer();
  try {
    init({ apiKey: "k", endpoint: `http://127.0.0.1:${port}` });
    const err = new Error("kaput");
    await captureException(err, { service: "svc" });
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.message, "kaput");
    assert.match(payload.stacktrace, /kaput/);
    assert.equal(payload.level, "error");
    assert.equal(payload.service, "svc");
  } finally {
    server.close();
  }
});

test("setUser + breadcrumbs are stamped on events", async () => {
  __resetForTests();
  const { server, requests, port } = await startCaptureServer();
  try {
    init({ apiKey: "k", endpoint: `http://127.0.0.1:${port}` });
    setUser("user-1");
    addBreadcrumb({ message: "clicked checkout" });
    await captureMessage("hi");
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.user_id, "user-1");
    assert.equal(payload.breadcrumbs.length, 1);
    clearBreadcrumbs();
    await captureMessage("hi2");
    assert.equal(JSON.parse(requests[1].body).breadcrumbs.length, 0);
  } finally {
    server.close();
  }
});

test("transport failures never reject", async () => {
  __resetForTests();
  init({ apiKey: "k", endpoint: "http://127.0.0.1:1", timeoutMs: 500 });
  await captureMessage("unreachable");
  await captureException(new Error("unreachable"));
  await flush();
});

test("close disables the client; wrap rethrows after reporting", async () => {
  __resetForTests();
  const { server, requests, port } = await startCaptureServer();
  try {
    init({ apiKey: "k", endpoint: `http://127.0.0.1:${port}` });
    close();
    await captureMessage("silent");
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }

  __resetForTests();
  const live = await startCaptureServer();
  try {
    init({ apiKey: "k", endpoint: `http://127.0.0.1:${live.port}` });
    const failing = wrap(async () => {
      throw new Error("wrapped");
    });
    await assert.rejects(failing(), /wrapped/);
    assert.equal(live.requests.length, 1);
  } finally {
    live.server.close();
  }
});
