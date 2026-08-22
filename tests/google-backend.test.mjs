import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GoogleBackendBridge, googleControlState, isRetryableGoogleError, normalizeGoogleBackendUrl, summarizeGoogleSetup } from "../src/google-backend.js";

const codeGs = readFileSync(new URL("../backend/apps-script/Code.gs", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

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
  const originalDocument = globalThis.document;
  const openCalls = [];
  const frames = [];
  const bridgeMessages = [];
  const authTab = {
    closed: false,
    close() { this.closed = true; }
  };
  const nestedAppsScriptFrame = {
    postMessage(message) { bridgeMessages.push(message); }
  };
  globalThis.window = {
    location: { origin: "https://orsinobbb.github.io", href: "https://orsinobbb.github.io/action-memory/" },
    open(...args) {
      openCalls.push(args);
      return authTab;
    },
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.document = {
    visibilityState: "visible",
    createElement(tag) {
      assert.equal(tag, "iframe");
      const frame = {
        contentWindow: { outerGoogleFrame: true },
        setAttribute() {},
        remove() { this.removed = true; }
      };
      frames.push(frame);
      return frame;
    },
    body: { append() {} },
    addEventListener() {},
    removeEventListener() {}
  };

  try {
    const bridge = new GoogleBackendBridge({ timeoutMs: 100 });
    const connecting = bridge.connect("https://script.google.com/macros/s/abc123/exec");
    bridge.handleMessage({
      origin: "https://script.googleusercontent.com",
      source: nestedAppsScriptFrame,
      data: { source: "action-memory-gas", type: "ready" }
    });
    await connecting;
    assert.equal(openCalls.length, 1);
    assert.equal(openCalls[0][1], "_blank");
    assert.equal(openCalls[0].length, 2);
    assert.equal(frames.length, 1);
    assert.match(frames[0].src, /origin=https%3A%2F%2Forsinobbb\.github\.io/);
    assert.match(frames[0].src, /return=https%3A%2F%2Forsinobbb\.github\.io%2Faction-memory%2F%3Fgoogle-return%3D1/);

    const request = bridge.request("initialize");
    assert.equal(bridgeMessages.length, 1);
    assert.equal(bridgeMessages[0].action, "initialize");
    bridge.handleMessage({
      origin: "https://script.googleusercontent.com",
      source: nestedAppsScriptFrame,
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
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
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

test("Google controls only enable restore after a successful backup", () => {
  assert.deepEqual(googleControlState(null), {
    connected: false, hasBackup: false, backupDisabled: true, restoreDisabled: true
  });
  assert.deepEqual(googleControlState({ initialized: true, hasBackup: false }), {
    connected: true, hasBackup: false, backupDisabled: false, restoreDisabled: true
  });
  assert.deepEqual(googleControlState({ initialized: true, hasBackup: true }), {
    connected: true, hasBackup: true, backupDisabled: false, restoreDisabled: false
  });
  assert.equal(googleControlState({ initialized: true, hasBackup: true }, "backup").restoreDisabled, true);
});

test("mobile reconnect initializes the backend and bridge failures are retryable", () => {
  assert.match(appJs, /reconnectGoogleBackendSilently[\s\S]*?requestGoogleBackend\("initialize"\)/);
  assert.equal(isRetryableGoogleError(new Error("Google 後端回應逾時")), true);
  assert.equal(isRetryableGoogleError(new Error("備份格式不相容")), false);
});

test("Code.gs is a self-contained setup and bridge bundle", () => {
  assert.doesNotThrow(() => new Function(codeGs));
  assert.match(codeGs, /function setup\(\)/);
  assert.match(codeGs, /createHtmlOutput\(buildBridgePage_\(origin, returnUrl\)\)/);
  assert.match(codeGs, /回到拾記完成連線/);
  assert.match(codeGs, /lastRequestId/);
  assert.match(codeGs, /duplicate: true/);
  assert.match(codeGs, /setXFrameOptionsMode\(HtmlService\.XFrameOptionsMode\.ALLOWALL\)/);
  assert.match(codeGs, /replace\(\/\^sha256:/);
  assert.doesNotMatch(codeGs, /createTemplateFromFile/);
});
