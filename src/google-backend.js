const SOURCE_WEB = "action-memory-web";
const SOURCE_GAS = "action-memory-gas";

export function normalizeGoogleBackendUrl(value) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "https:" || url.hostname !== "script.google.com" || !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname)) {
    throw new Error("請貼上 Apps Script 網頁應用程式的 /exec 網址");
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

export const GOOGLE_SETUP_FILES = Object.freeze(["Code.gs", "Bridge.html", "appsscript.json"]);

export function summarizeGoogleSetup({ projectOpened = false, copiedFiles = [], url = "", initialized = false } = {}) {
  let published = false;
  try {
    published = new URL(normalizeGoogleBackendUrl(url)).pathname.endsWith("/exec");
  } catch {
    published = false;
  }
  const copied = new Set(Array.isArray(copiedFiles) ? copiedFiles : []);
  const filesReady = GOOGLE_SETUP_FILES.every((file) => copied.has(file));
  const steps = {
    project: Boolean(projectOpened || published),
    files: Boolean(filesReady || published),
    deploy: published,
    connect: Boolean(initialized)
  };
  return {
    steps,
    completed: Object.values(steps).filter(Boolean).length,
    total: Object.keys(steps).length,
    published
  };
}

export class GoogleBackendBridge {
  constructor({ timeoutMs = 120000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.popup = null;
    this.pending = new Map();
    this.ready = false;
    this.handleMessage = this.handleMessage.bind(this);
  }

  async connect(rawUrl) {
    this.url = normalizeGoogleBackendUrl(rawUrl);
    const bridgeUrl = new URL(this.url);
    bridgeUrl.searchParams.set("origin", window.location.origin);
    this.popup = window.open(bridgeUrl.href, "action-memory-google", "popup,width=520,height=700");
    if (!this.popup) throw new Error("瀏覽器已阻擋 Google 授權視窗，請允許彈出視窗後重試");
    window.addEventListener("message", this.handleMessage);
    try {
      await new Promise((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
        this.readyTimer = setTimeout(() => reject(new Error("等待 Google 授權逾時，請確認授權視窗")), this.timeoutMs);
      });
    } catch (error) {
      this.close();
      throw error;
    }
    return this;
  }

  handleMessage(event) {
    let sender;
    try { sender = new URL(event.origin); } catch { return; }
    const isGoogleScript = sender.hostname === "script.google.com" || sender.hostname === "script.googleusercontent.com" || sender.hostname.endsWith(".googleusercontent.com");
    if (event.source !== this.popup || sender.protocol !== "https:" || !isGoogleScript || !event.data || event.data.source !== SOURCE_GAS) return;
    if (event.data.type === "ready") {
      clearTimeout(this.readyTimer);
      this.ready = true;
      this.readyResolve && this.readyResolve();
      return;
    }
    const pending = this.pending.get(event.data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(event.data.requestId);
    if (event.data.ok) pending.resolve(event.data.result);
    else pending.reject(new Error(event.data.error || "Google 後端未完成要求"));
  }

  request(action, payload = {}) {
    if (!this.ready || !this.popup || this.popup.closed) return Promise.reject(new Error("請先重新連接 Google 後端"));
    const requestId = `gas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Google 後端回應逾時"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.popup.postMessage({ source: SOURCE_WEB, requestId, action, payload }, "*");
    });
  }

  close() {
    window.removeEventListener("message", this.handleMessage);
    if (this.popup && !this.popup.closed) this.popup.close();
    this.ready = false;
  }
}
