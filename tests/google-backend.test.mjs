import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGoogleBackendUrl, summarizeGoogleSetup } from "../src/google-backend.js";

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

test("setup progress accepts an existing published backend without replaying manual steps", () => {
  const progress = summarizeGoogleSetup({
    url: "https://script.google.com/macros/s/abc123/exec",
    initialized: true
  });
  assert.equal(progress.completed, 4);
  assert.deepEqual(progress.steps, { project: true, files: true, deploy: true, connect: true });
});

test("setup progress requires all source files before deployment", () => {
  const progress = summarizeGoogleSetup({
    projectOpened: true,
    copiedFiles: ["Code.gs", "Bridge.html"]
  });
  assert.equal(progress.completed, 1);
  assert.equal(progress.steps.files, false);
  assert.equal(progress.steps.deploy, false);
});
