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
    createFolder(name) {
      const folder = {
        id: nextId("folder"),
        name,
        getId() { return this.id; },
        getName() { return this.name; },
        createFile(fileName, content) {
          const file = {
            id: nextId("file"), fileName, content,
            getId() { return this.id; },
            getBlob() { return { getDataAsString: () => this.content }; }
          };
          files.set(file.id, file);
          return file;
        }
      };
      folders.set(folder.id, folder);
      return folder;
    },
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
    computeDigest(_algorithm, text) { return [...createHash("sha256").update(text, "utf8").digest()]; },
    newBlob(text) { return { getBytes: () => [...Buffer.from(text, "utf8")] }; }
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
  const factory = new Function(...Object.keys(context), `${codeGs}\nreturn { setup, pushBackup_, pullBackup_ };`);
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
