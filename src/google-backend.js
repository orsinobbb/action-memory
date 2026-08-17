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

export const GOOGLE_SETUP_FILES = Object.freeze(["Code.gs"]);

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
    this.authTab = null;
    this.bridgeFrame = null;
    this.bridgeWindow = null;
    this.pending = new Map();
    this.ready = false;
    this.handleMessage = this.handleMessage.bind(this);
    this.handleReturn = this.handleReturn.bind(this);
  }

  async connect(rawUrl, { authorize = true } = {}) {
    this.url = normalizeGoogleBackendUrl(rawUrl);
    window.addEventListener("message", this.handleMessage);
    document.addEventListener("visibilitychange", this.handleReturn);
    window.addEventListener("focus", this.handleReturn);
    if (authorize) {
      this.authTab = window.open(this.bridgeUrl(), "_blank");
      if (!this.authTab) {
        this.close();
        throw new Error("瀏覽器未能開啟 Google 授權分頁，請允許開啟新分頁後重試");
      }
    }
    this.mountFrame();
    try {
      await new Promise((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
        this.readyTimer = setTimeout(() => reject(new Error("尚未收到 Google 回應。若已授權，請確認 Apps Script 已更新為最新版並重新部署。")), this.timeoutMs);
      });
    } catch (error) {
      this.close();
      throw error;
    }
    return this;
  }

  bridgeUrl() {
    const url = new URL(this.url);
    url.searchParams.set("origin", window.location.origin);
    return url.href;
  }

  mountFrame() {
    if (this.bridgeFrame) this.bridgeFrame.remove();
    const frame = document.createElement("iframe");
    frame.src = this.bridgeUrl();
    frame.title = "拾記 Google 資料連線";
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    document.body.append(frame);
    this.bridgeFrame = frame;
  }

  handleReturn() {
    if (!this.ready && document.visibilityState === "visible") this.mountFrame();
  }

  handleMessage(event) {
    let sender;
    try { sender = new URL(event.origin); } catch { return; }
    const isGoogleScript = sender.hostname === "script.google.com" || sender.hostname === "script.googleusercontent.com" || sender.hostname.endsWith(".googleusercontent.com");
    if (sender.protocol !== "https:" || !isGoogleScript || !event.data || event.data.source !== SOURCE_GAS) return;
    if (event.data.type === "ready") {
      this.bridgeWindow = event.source;
      clearTimeout(this.readyTimer);
      this.ready = true;
      this.readyResolve && this.readyResolve();
      return;
    }
    if (!this.bridgeWindow || event.source !== this.bridgeWindow) return;
    const pending = this.pending.get(event.data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(event.data.requestId);
    if (event.data.ok) pending.resolve(event.data.result);
    else pending.reject(new Error(event.data.error || "Google 後端未完成要求"));
  }

  request(action, payload = {}) {
    if (!this.ready || !this.bridgeWindow) return Promise.reject(new Error("Google 授權連線已中斷，請重新連接"));
    const requestId = `gas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Google 後端回應逾時"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.bridgeWindow.postMessage({ source: SOURCE_WEB, requestId, action, payload }, "*");
    });
  }

  close() {
    window.removeEventListener("message", this.handleMessage);
    window.removeEventListener("focus", this.handleReturn);
    document.removeEventListener("visibilitychange", this.handleReturn);
    clearTimeout(this.readyTimer);
    if (this.bridgeFrame) this.bridgeFrame.remove();
    if (this.authTab && !this.authTab.closed) this.authTab.close();
    this.bridgeFrame = null;
    this.bridgeWindow = null;
    this.ready = false;
  }
}
