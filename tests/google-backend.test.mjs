import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGoogleBackendUrl } from "../src/google-backend.js";

test("accepts an Apps Script exec URL and removes query data", () => {
  assert.equal(
    normalizeGoogleBackendUrl("https://script.google.com/macros/s/abc123/exec?old=1#x"),
    "https://script.google.com/macros/s/abc123/exec"
  );
});

test("rejects non-Google and editor URLs", () => {
  assert.throws(() => normalizeGoogleBackendUrl("https://example.com/macros/s/abc/exec"));
  assert.throws(() => normalizeGoogleBackendUrl("https://script.google.com/home/projects/abc/edit"));
});
