const ACTION_MEMORY = Object.freeze({
  version: "0.2.0",
  folderName: "拾記 Action Memory",
  spreadsheetName: "拾記雲端備份索引",
  maxBackupBytes: 5 * 1024 * 1024,
  allowedOrigins: [
    "https://orsinobbb.github.io",
    "http://localhost:8080",
    "http://127.0.0.1:8080"
  ]
});

const PROPERTY_KEYS = Object.freeze({
  folderId: "action_memory_folder_id",
  spreadsheetId: "action_memory_spreadsheet_id",
  latestFileId: "action_memory_latest_file_id",
  revision: "action_memory_revision",
  createdAt: "action_memory_created_at"
});

function doGet(e) {
  const origin = String((e && e.parameter && e.parameter.origin) || "");
  if (ACTION_MEMORY.allowedOrigins.indexOf(origin) === -1) {
    return HtmlService.createHtmlOutput("此來源未獲拾記後端允許。");
  }
  return HtmlService.createHtmlOutput(buildBridgePage_(origin)).setTitle("拾記 Google 連接");
}

function setup() {
  const health = initializeBackend_();
  console.log("拾記 Google 後端已完成初始化。");
  console.log("備份索引：" + health.spreadsheetUrl);
  console.log("下一步：部署為網頁應用程式，再將 /exec 網址貼回拾記。");
  return health;
}

function buildBridgePage_(allowedOrigin) {
  const originJson = JSON.stringify(allowedOrigin).replace(/</g, "\\u003c");
  const versionJson = JSON.stringify(ACTION_MEMORY.version).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <base target="_top">
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>拾記 Google 連接</title>
    <style>
      body { margin: 0; padding: 28px; color: #153a35; background: #f7f6f1; font: 16px/1.6 system-ui, sans-serif; }
      main { max-width: 420px; margin: 12vh auto; padding: 24px; background: white; border-radius: 24px; box-shadow: 0 18px 55px #163b321c; }
      small { color: #657a76; }
    </style>
  </head>
  <body>
    <main><h1>拾記 Google 連接</h1><p id="status">已取得 Google 授權，正在等待拾記。</p><small>後端版本 <span id="version"></span></small></main>
    <script>
      const allowedOrigin = ${originJson};
      document.getElementById("version").textContent = ${versionJson};
      const statusNode = document.getElementById("status");
      function reply(message) { if (window.opener) window.opener.postMessage(message, allowedOrigin); }
      window.addEventListener("message", (event) => {
        const message = event.data || {};
        if (event.origin !== allowedOrigin || event.source !== window.opener || message.source !== "action-memory-web") return;
        statusNode.textContent = "正在處理「" + message.action + "」…";
        google.script.run
          .withSuccessHandler((result) => {
            statusNode.textContent = "完成，可回到拾記。";
            reply({ source: "action-memory-gas", requestId: message.requestId, ok: true, result });
          })
          .withFailureHandler((error) => {
            statusNode.textContent = "未完成：" + (error && error.message ? error.message : "未知錯誤");
            reply({ source: "action-memory-gas", requestId: message.requestId, ok: false, error: statusNode.textContent });
          })
          .bridgeCommand({ action: message.action, payload: message.payload || {} });
      });
      reply({ source: "action-memory-gas", type: "ready" });
    <\/script>
  </body>
</html>`;
}

function bridgeCommand(request) {
  if (!request || typeof request.action !== "string") throw new Error("缺少後端動作");
  switch (request.action) {
    case "initialize": return initializeBackend_();
    case "health": return backendHealth_();
    case "push": return pushBackup_(request.payload || {});
    case "pull": return pullBackup_();
    default: throw new Error("不支援的後端動作");
  }
}

function initializeBackend_() {
  const lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    const current = backendHealth_();
    if (current.initialized) return current;

    const folder = DriveApp.createFolder(ACTION_MEMORY.folderName);
    const spreadsheet = SpreadsheetApp.create(ACTION_MEMORY.spreadsheetName);
    DriveApp.getFileById(spreadsheet.getId()).moveTo(folder);

    const snapshots = spreadsheet.getSheets()[0];
    snapshots.setName("Snapshots");
    snapshots.getRange(1, 1, 1, 8).setValues([[
      "revision", "createdAt", "deviceId", "checksum", "fileId", "requestId", "bytes", "schemaVersion"
    ]]);
    const events = spreadsheet.insertSheet("Events");
    events.getRange(1, 1, 1, 5).setValues([["at", "type", "deviceId", "requestId", "revision"]]);
    spreadsheet.insertSheet("Meta").getRange(1, 1, 4, 2).setValues([
      ["backendVersion", ACTION_MEMORY.version],
      ["createdAt", new Date().toISOString()],
      ["storage", "Google Drive JSON + Google Sheets index"],
      ["conflictPolicy", "baseRevision must match"]
    ]);

    const properties = PropertiesService.getUserProperties();
    properties.setProperties({
      [PROPERTY_KEYS.folderId]: folder.getId(),
      [PROPERTY_KEYS.spreadsheetId]: spreadsheet.getId(),
      [PROPERTY_KEYS.revision]: "0",
      [PROPERTY_KEYS.createdAt]: new Date().toISOString()
    });
    return backendHealth_();
  } finally {
    lock.releaseLock();
  }
}

function backendHealth_() {
  const properties = PropertiesService.getUserProperties();
  const folderId = properties.getProperty(PROPERTY_KEYS.folderId);
  const spreadsheetId = properties.getProperty(PROPERTY_KEYS.spreadsheetId);
  if (!folderId || !spreadsheetId) return healthResult_(false, properties);
  try {
    DriveApp.getFolderById(folderId).getName();
    SpreadsheetApp.openById(spreadsheetId).getName();
    return healthResult_(true, properties);
  } catch (error) {
    return Object.assign(healthResult_(false, properties), { diagnostic: "已儲存的 Google 資源不存在或無權存取" });
  }
}

function healthResult_(initialized, properties) {
  const spreadsheetId = properties.getProperty(PROPERTY_KEYS.spreadsheetId);
  return {
    initialized: initialized,
    backendVersion: ACTION_MEMORY.version,
    revision: Number(properties.getProperty(PROPERTY_KEYS.revision) || 0),
    hasBackup: Boolean(properties.getProperty(PROPERTY_KEYS.latestFileId)),
    createdAt: properties.getProperty(PROPERTY_KEYS.createdAt) || null,
    spreadsheetUrl: initialized && spreadsheetId ? "https://docs.google.com/spreadsheets/d/" + spreadsheetId + "/edit" : null
  };
}

function pushBackup_(request) {
  const lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    const health = backendHealth_();
    if (!health.initialized) throw new Error("請先初始化 Google 後端");
    const backup = request.backup;
    validateBackup_(backup);

    const properties = PropertiesService.getUserProperties();
    const currentRevision = Number(properties.getProperty(PROPERTY_KEYS.revision) || 0);
    const baseRevision = Number(request.baseRevision);
    if (!Number.isFinite(baseRevision) || baseRevision !== currentRevision) {
      return { ok: false, conflict: true, revision: currentRevision, message: "雲端版本已變更，未覆寫資料" };
    }

    const requestId = String(request.requestId || "");
    if (!requestId) throw new Error("缺少 requestId");
    const json = JSON.stringify(backup);
    if (Utilities.newBlob(json).getBytes().length > ACTION_MEMORY.maxBackupBytes) throw new Error("備份超過 5 MB 上限");

    const nextRevision = currentRevision + 1;
    const folder = DriveApp.getFolderById(properties.getProperty(PROPERTY_KEYS.folderId));
    const fileName = "action-memory-r" + nextRevision + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    const file = folder.createFile(fileName, json, MimeType.PLAIN_TEXT);
    const spreadsheet = SpreadsheetApp.openById(properties.getProperty(PROPERTY_KEYS.spreadsheetId));
    spreadsheet.getSheetByName("Snapshots").appendRow([
      nextRevision, new Date().toISOString(), String(request.deviceId || "unknown"), backup.checksum,
      file.getId(), requestId, Utilities.newBlob(json).getBytes().length, backup.schemaVersion
    ]);
    spreadsheet.getSheetByName("Events").appendRow([
      new Date().toISOString(), "backup_pushed", String(request.deviceId || "unknown"), requestId, nextRevision
    ]);
    properties.setProperty(PROPERTY_KEYS.latestFileId, file.getId());
    properties.setProperty(PROPERTY_KEYS.revision, String(nextRevision));
    return Object.assign({ ok: true, revision: nextRevision, checksum: backup.checksum }, backendHealth_());
  } finally {
    lock.releaseLock();
  }
}

function pullBackup_() {
  const health = backendHealth_();
  if (!health.initialized) throw new Error("請先初始化 Google 後端");
  const fileId = PropertiesService.getUserProperties().getProperty(PROPERTY_KEYS.latestFileId);
  if (!fileId) return { ok: true, revision: health.revision, backup: null };
  const backup = JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString("UTF-8"));
  validateBackup_(backup);
  return { ok: true, revision: health.revision, backup: backup };
}

function validateBackup_(backup) {
  if (!backup || backup.schemaVersion !== 1 || !backup.payload) throw new Error("備份格式不相容");
  ["tasks", "relations", "events"].forEach(function (key) {
    if (!Array.isArray(backup.payload[key])) throw new Error("備份缺少 " + key);
  });
  if (!/^[a-f0-9]{64}$/i.test(String(backup.checksum || ""))) throw new Error("備份校驗碼不正確");
  if (sha256Hex_(JSON.stringify(backup.payload)) !== String(backup.checksum).toLowerCase()) throw new Error("備份內容與校驗碼不符");
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (value) { return (value < 0 ? value + 256 : value).toString(16).padStart(2, "0"); })
    .join("");
}
