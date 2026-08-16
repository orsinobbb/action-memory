const ACTION_MEMORY = Object.freeze({
  version: "0.1.0",
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
  const template = HtmlService.createTemplateFromFile("Bridge");
  template.allowedOrigin = origin;
  template.backendVersion = ACTION_MEMORY.version;
  return template.evaluate().setTitle("拾記 Google 連接");
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
