import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GoogleBackendBridge, normalizeGoogleBackendUrl, summarizeGoogleSetup } from "../src/google-backend.js";

const codeGs = readFileSync(new URL("../backend/apps-script/Code.gs", import.meta.url), "utf8");

test("accepts an Apps Script exec URL and removes query data", () => {
  assert.equal(
    normalizeGoogleBackendUrl("https://script.google.com/macros/s/abc123/exec?old=1#x"),
    "https://script.google.com/macros/s/abc123/exec"
  );
});

test("rejects non-Google and editor URLs", () => {
  assert.throws(() => normalizeGoogleBackendUrl("https://example.com/macros/s/abc/exec"));
  assert.throws(() => normalizeGoogleBackendUrl("https://script.google.com/home/projects/abc/edit"));
  assert.throws(() => normalizeGoogleBackendUrl("https://script.google.com/macros/s/abc/dev"));
});

test("opens Google authorization in a normal separate tab", async () => {
  const originalWindow = globalThis.window;
  const openCalls = [];
  const bridgeMessages = [];
  const authTab = {
    closed: false,
    close() { this.closed = true; }
  };
  const bridgeFrame = {
    postMessage(message) { bridgeMessages.push(message); }
  };
  globalThis.window = {
    location: { origin: "https://orsinobbb.github.io" },
    open(...args) {
      openCalls.push(args);
      return authTab;
    },
    addEventListener() {},
    removeEventListener() {}
  };

  try {
    const bridge = new GoogleBackendBridge({ timeoutMs: 100 });
    const connecting = bridge.connect("https://script.google.com/macros/s/abc123/exec");
    bridge.handleMessage({
      origin: "https://script.googleusercontent.com",
      source: bridgeFrame,
      data: { source: "action-memory-gas", type: "ready" }
    });
    await connecting;
    assert.equal(openCalls.length, 1);
    assert.equal(openCalls[0][1], "_blank");
    assert.equal(openCalls[0].length, 2);

    const request = bridge.request("initialize");
    assert.equal(bridgeMessages.length, 1);
    assert.equal(bridgeMessages[0].action, "initialize");
    bridge.handleMessage({
      origin: "https://script.googleusercontent.com",
      source: bridgeFrame,
      data: {
        source: "action-memory-gas",
        requestId: bridgeMessages[0].requestId,
        ok: true,
        result: { initialized: true }
      }
    });
    assert.deepEqual(await request, { initialized: true });
    bridge.close();
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("setup progress accepts an existing published backend without replaying manual steps", () => {
  const progress = summarizeGoogleSetup({
    url: "https://script.google.com/macros/s/abc123/exec",
    initialized: true
  });
  assert.equal(progress.completed, 4);
  assert.deepEqual(progress.steps, { project: true, files: true, deploy: true, connect: true });
});

test("setup progress only requires the single Code.gs file", () => {
  const progress = summarizeGoogleSetup({
    projectOpened: true,
    copiedFiles: ["Code.gs"]
  });
  assert.equal(progress.completed, 2);
  assert.equal(progress.steps.files, true);
  assert.equal(progress.steps.deploy, false);
});

test("Code.gs is a self-contained setup and bridge bundle", () => {
  assert.doesNotThrow(() => new Function(codeGs));
  assert.match(codeGs, /function setup\(\)/);
  assert.match(codeGs, /createHtmlOutput\(buildBridgePage_\(origin\)\)/);
  assert.doesNotMatch(codeGs, /createTemplateFromFile/);
});
