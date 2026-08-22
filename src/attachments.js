export const MAX_ATTACHMENT_COUNT = 12;
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_STORED_BYTES = 1.8 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 1600;

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Blob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export function attachmentManifest(attachment) {
  return {
    id: attachment.id,
    taskId: attachment.taskId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
    checksum: attachment.checksum,
    cloudFileId: attachment.cloudFileId || null,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt
  };
}

export function formatAttachmentSize(size) {
  if (!Number.isFinite(size) || size <= 0) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBlob(base64, mimeType = "application/octet-stream") {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("瀏覽器無法壓縮這張圖片")), type, quality);
  });
}

function loadHtmlImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("無法讀取這張圖片；可先轉成 JPG 或 PNG 再試一次"));
    };
    image.src = url;
  });
}

export async function compressImageFile(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("只能加入圖片檔案");
  if (file.size > MAX_INPUT_BYTES) throw new Error("原始圖片超過 20 MB，請先縮小再加入");

  const image = await loadHtmlImage(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) throw new Error("無法取得圖片尺寸");

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  let blob = await canvasToBlob(canvas, "image/jpeg", 0.82);
  if (blob.size > MAX_STORED_BYTES) blob = await canvasToBlob(canvas, "image/jpeg", 0.68);
  if (blob.size > MAX_STORED_BYTES) throw new Error("壓縮後仍超過 1.8 MB，請先裁切或縮小圖片");
  return { blob, width, height, mimeType: "image/jpeg" };
}

export async function prepareImageAttachment(file, taskId, id, now = new Date()) {
  const compressed = await compressImageFile(file);
  const timestamp = now.toISOString();
  const stem = String(file.name || "照片").replace(/\.[^.]+$/, "").slice(0, 80) || "照片";
  return {
    id,
    taskId,
    name: `${stem}.jpg`,
    mimeType: compressed.mimeType,
    size: compressed.blob.size,
    width: compressed.width,
    height: compressed.height,
    checksum: await sha256Blob(compressed.blob),
    blob: compressed.blob,
    cloudFileId: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
