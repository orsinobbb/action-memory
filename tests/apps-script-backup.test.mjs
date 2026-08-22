import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const codeGs = readFileSync(new URL("../backend/apps-script/Code.gs", import.meta.url), "utf8");

function createAppsScriptRuntime() {
  let sequence = 0;
  const properties = new Map();
  const folders = new Map();
  const files = new Map();
  const spreadsheets = new Map();
  const nextId = (prefix) => `${prefix}-${++sequence}`;
  const iterator = (items) => {
    let index = 0;
    return { hasNext: () => index < items.length, next: () => items[index++] };
  };

  function makeBlob(value, mimeType = "text/plain", name = "") {
    const bytes = Buffer.isBuffer(value) ? value : Array.isArray(value) ? Buffer.from(value) : Buffer.from(String(value), "utf8");
    return {
      getBytes: () => [...bytes],
      getDataAsString: () => bytes.toString("utf8"),
      getContentType: () => mimeType,
      getName: () => name
    };
  }

  function createFolder(name, parent = null) {
    const folder = {
      id: nextId("folder"), name, parent, childFolders: [], childFiles: [],
      getId() { return this.id; },
      getName() { return this.name; },
      createFolder(childName) {
        const child = createFolder(childName, this);
        this.childFolders.push(child);
        return child;
      },
      getFoldersByName(childName) { return iterator(this.childFolders.filter((item) => item.name === childName)); },
      getFilesByName(fileName) { return iterator(this.childFiles.filter((item) => item.fileName === fileName)); },
      createFile(fileNameOrBlob, content) {
        const blob = typeof fileNameOrBlob === "string" ? makeBlob(content, "text/plain", fileNameOrBlob) : fileNameOrBlob;
        const fileName = typeof fileNameOrBlob === "string" ? fileNameOrBlob : blob.getName();
        const file = {
          id: nextId("file"), fileName, blob, parent: this,
          getId() { return this.id; },
          getName() { return this.fileName; },
          getBlob() { return this.blob; },
          getParents() { return iterator([this.parent]); }
        };
        this.childFiles.push(file);
        files.set(file.id, file);
        return file;
      }
    };
    folders.set(folder.id, folder);
    return folder;
  }

  class Sheet {
    constructor(name) { this.name = name; this.rows = []; }
    setName(name) { this.name = name; return this; }
    getRange() { return { setValues: (rows) => { this.rows.push(...rows); } }; }
    appendRow(row) { this.rows.push(row); }
  }

  class Spreadsheet {
    constructor(name) {
      this.id = nextId("sheet");
      this.name = name;
      this.sheets = [new Sheet("Sheet1")];
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getSheets() { return this.sheets; }
    insertSheet(name) { const sheet = new Sheet(name); this.sheets.push(sheet); return sheet; }
    getSheetByName(name) { return this.sheets.find((sheet) => sheet.name === name); }
  }

  const userProperties = {
    getProperty: (key) => properties.get(key) || null,
    setProperty: (key, value) => properties.set(key, String(value)),
    setProperties: (values) => Object.entries(values).forEach(([key, value]) => properties.set(key, String(value)))
  };

  const DriveApp = {
    createFolder,
    getFolderById(id) { return folders.get(id); },
    getFileById(id) {
      if (files.has(id)) return files.get(id);
      if (spreadsheets.has(id)) return { moveTo() {} };
      throw new Error(`Unknown file ${id}`);
    }
  };

  const SpreadsheetApp = {
    create(name) {
      const spreadsheet = new Spreadsheet(name);
      spreadsheets.set(spreadsheet.id, spreadsheet);
      return spreadsheet;
    },
    openById(id) { return spreadsheets.get(id); }
  };

  const Utilities = {
    Charset: { UTF_8: "UTF-8" },
    DigestAlgorithm: { SHA_256: "SHA_256" },
    computeDigest(_algorithm, value) {
      const bytes = Array.isArray(value) ? Buffer.from(value) : Buffer.from(String(value), "utf8");
      return [...createHash("sha256").update(bytes).digest()];
    },
    newBlob: makeBlob,
    base64Decode: (value) => [...Buffer.from(value, "base64")],
    base64Encode: (value) => Buffer.from(value).toString("base64")
  };

  const context = {
    DriveApp,
    SpreadsheetApp,
    PropertiesService: { getUserProperties: () => userProperties },
    LockService: { getUserLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities,
    MimeType: { PLAIN_TEXT: "text/plain" },
    HtmlService: {},
    console
  };
  const factory = new Function(...Object.keys(context), `${codeGs}\nreturn { setup, pushBackup_, pullBackup_, putAttachment_, getAttachment_ };`);
  return { api: factory(...Object.values(context)), files };
}

test("Apps Script initializes, backs up, restores, and deduplicates a retry", () => {
  const runtime = createAppsScriptRuntime();
  const initialized = runtime.api.setup();
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.revision, 0);

  const payload = { tasks: [{ id: "task-1" }], relations: [], events: [] };
  const backup = {
    schemaVersion: 1,
    payload,
    checksum: `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`
  };
  const request = {
    backup: { ...backup, payload: { events: [], relations: [], tasks: [{ id: "transport-reordered" }] } },
    backupJson: JSON.stringify(backup),
    baseRevision: 0,
    deviceId: "test",
    requestId: "request-1"
  };
  const pushed = runtime.api.pushBackup_(request);
  assert.equal(pushed.revision, 1);
  assert.equal(pushed.hasBackup, true);

  const retried = runtime.api.pushBackup_(request);
  assert.equal(retried.duplicate, true);
  assert.equal(retried.revision, 1);
  assert.equal(runtime.files.size, 1);

  const pulled = runtime.api.pullBackup_();
  assert.deepEqual(pulled.backup, backup);
  assert.equal(pulled.revision, 1);
});

test("Apps Script uploads and restores a checksum-verified image attachment", () => {
  const runtime = createAppsScriptRuntime();
  runtime.api.setup();
  const bytes = Buffer.from("fake-jpeg-content", "utf8");
  const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const request = {
    id: "attachment_test-1234",
    mimeType: "image/jpeg",
    base64: bytes.toString("base64"),
    checksum
  };

  const uploaded = runtime.api.putAttachment_(request);
  assert.equal(uploaded.ok, true);
  assert.equal(runtime.api.putAttachment_(request).duplicate, true);

  const downloaded = runtime.api.getAttachment_({ fileId: uploaded.fileId });
  assert.equal(downloaded.base64, request.base64);
  assert.equal(downloaded.checksum, checksum);
  assert.equal(downloaded.mimeType, "image/jpeg");
});
