import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const {
  attachmentManifest,
  base64ToBlob,
  blobToBase64,
  formatAttachmentSize,
  sha256Blob
} = await import("../src/attachments.js");

test("圖片附件 manifest 不會把本機 Blob 塞進 JSON", () => {
  const blob = new Blob(["photo"], { type: "image/jpeg" });
  const manifest = attachmentManifest({
    id: "attachment_1",
    taskId: "task_1",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    size: blob.size,
    width: 1200,
    height: 800,
    checksum: "sha256:abc",
    cloudFileId: "drive-file-1",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    blob
  });
  assert.equal("blob" in manifest, false);
  assert.equal(manifest.cloudFileId, "drive-file-1");
});

test("圖片可轉為 base64 後完整還原並通過校驗", async () => {
  const original = new Blob(["binary-photo-content"], { type: "image/jpeg" });
  const base64 = await blobToBase64(original);
  const restored = base64ToBlob(base64, "image/jpeg");
  assert.equal(await restored.text(), await original.text());
  assert.equal(await sha256Blob(restored), await sha256Blob(original));
  assert.equal(formatAttachmentSize(1536), "2 KB");
});
