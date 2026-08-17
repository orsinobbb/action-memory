import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeGoogleBackendUrl, summarizeGoogleSetup } from "../src/google-backend.js";

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
