const DB_NAME = "action-memory";
const DB_VERSION = 2;
const STORES = ["tasks", "relations", "events", "attachments", "settings"];

let databasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("資料庫交易已中止"));
  });
}

export function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("tasks")) db.createObjectStore("tasks", { keyPath: "id" });
        if (!db.objectStoreNames.contains("relations")) db.createObjectStore("relations", { keyPath: "id" });
        if (!db.objectStoreNames.contains("events")) {
          const store = db.createObjectStore("events", { keyPath: "id" });
          store.createIndex("entityId", "entityId", { unique: false });
          store.createIndex("at", "at", { unique: false });
        }
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
        if (!db.objectStoreNames.contains("attachments")) {
          const store = db.createObjectStore("attachments", { keyPath: "id" });
          store.createIndex("taskId", "taskId", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return databasePromise;
}

export async function getAll(storeName) {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
}

export async function getById(storeName, id) {
  const db = await openDatabase();
  return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).get(id));
}

export async function getAllData() {
  const [tasks, relations, events, attachments] = await Promise.all([
    getAll("tasks"),
    getAll("relations"),
    getAll("events"),
    getAll("attachments")
  ]);
  return { tasks, relations, events, attachments };
}

export async function getSetting(key) {
  const record = await getById("settings", key);
  return record ? record.value : undefined;
}

export async function setSetting(key, value) {
  const db = await openDatabase();
  const transaction = db.transaction("settings", "readwrite");
  transaction.objectStore("settings").put({ key, value });
  await transactionDone(transaction);
}

export async function addEvent(event) {
  const db = await openDatabase();
  const transaction = db.transaction("events", "readwrite");
  transaction.objectStore("events").add(event);
  await transactionDone(transaction);
}

export async function addTask(task, event) {
  const db = await openDatabase();
  const transaction = db.transaction(["tasks", "events"], "readwrite");
  transaction.objectStore("tasks").add(task);
  transaction.objectStore("events").add(event);
  await transactionDone(transaction);
}

export async function addAttachment(attachment, event) {
  const db = await openDatabase();
  const transaction = db.transaction(["attachments", "events"], "readwrite");
  transaction.objectStore("attachments").add(attachment);
  transaction.objectStore("events").add(event);
  await transactionDone(transaction);
}

export async function updateAttachment(attachment) {
  const db = await openDatabase();
  const transaction = db.transaction("attachments", "readwrite");
  transaction.objectStore("attachments").put(attachment);
  await transactionDone(transaction);
}

export async function removeAttachment(attachmentId, event) {
  const db = await openDatabase();
  const transaction = db.transaction(["attachments", "events"], "readwrite");
  transaction.objectStore("attachments").delete(attachmentId);
  transaction.objectStore("events").add(event);
  await transactionDone(transaction);
}

export async function updateTask(task, event) {
  const db = await openDatabase();
  const transaction = db.transaction(["tasks", "events"], "readwrite");
  transaction.objectStore("tasks").put(task);
  transaction.objectStore("events").add(event);
  await transactionDone(transaction);
}

export async function completeRecurringTask(task, completionEvent, nextTask, nextEvent, relation) {
  const db = await openDatabase();
  const transaction = db.transaction(["tasks", "relations", "events"], "readwrite");
  const taskStore = transaction.objectStore("tasks");
  const eventStore = transaction.objectStore("events");
  taskStore.put(task);
  taskStore.add(nextTask);
  transaction.objectStore("relations").add(relation);
  eventStore.add(completionEvent);
  eventStore.add(nextEvent);
  await transactionDone(transaction);
}

export async function removeTask(taskId, event) {
  const db = await openDatabase();
  const existingRelations = await getAll("relations");
  const existingAttachments = await getAll("attachments");
  const transaction = db.transaction(["tasks", "relations", "events", "attachments"], "readwrite");
  transaction.objectStore("tasks").delete(taskId);
  const relationStore = transaction.objectStore("relations");
  existingRelations.filter((item) => item.fromId === taskId || item.toId === taskId).forEach((item) => relationStore.delete(item.id));
  const attachmentStore = transaction.objectStore("attachments");
  existingAttachments.filter((item) => item.taskId === taskId).forEach((item) => attachmentStore.delete(item.id));
  transaction.objectStore("events").add(event);
  await transactionDone(transaction);
}

export async function addRelation(relation, event) {
  const db = await openDatabase();
  const transaction = db.transaction(["relations", "events"], "readwrite");
  transaction.objectStore("relations").add(relation);
  transaction.objectStore("events").add(event);
  await transactionDone(transaction);
}

export async function removeRelation(relationId, event) {
  const db = await openDatabase();
  const transaction = db.transaction(["relations", "events"], "readwrite");
  transaction.objectStore("relations").delete(relationId);
  transaction.objectStore("events").add(event);
  await transactionDone(transaction);
}

export async function importData(payload, mode, importEvent) {
  const db = await openDatabase();
  const currentTasks = mode === "merge" ? await getAll("tasks") : [];
  const currentAttachments = mode === "merge" ? await getAll("attachments") : [];
  const currentTaskMap = new Map(currentTasks.map((task) => [task.id, task]));
  const currentAttachmentMap = new Map(currentAttachments.map((attachment) => [attachment.id, attachment]));
  const transaction = db.transaction(["tasks", "relations", "events", "attachments"], "readwrite");
  const stores = Object.fromEntries(["tasks", "relations", "events", "attachments"].map((name) => [name, transaction.objectStore(name)]));

  if (mode === "replace") Object.values(stores).forEach((store) => store.clear());

  for (const task of payload.tasks) {
    if (mode === "replace") stores.tasks.put(task);
    else {
      const current = currentTaskMap.get(task.id);
      const taskVersion = task.version === null || task.version === undefined ? 1 : task.version;
      const currentVersion = !current || current.version === null || current.version === undefined ? 1 : current.version;
      if (!current || taskVersion > currentVersion) stores.tasks.put(task);
    }
  }
  for (const relation of payload.relations) stores.relations.put(relation);
  for (const event of payload.events) stores.events.put(event);
  for (const attachment of payload.attachments || []) {
    if (mode === "replace") stores.attachments.put(attachment);
    else {
      const current = currentAttachmentMap.get(attachment.id);
      if (!current || String(attachment.updatedAt || "") >= String(current.updatedAt || "")) {
        stores.attachments.put(current?.blob && !attachment.blob ? { ...attachment, blob: current.blob } : attachment);
      }
    }
  }
  stores.events.put(importEvent);
  await transactionDone(transaction);
}

export async function clearDatabaseForTests() {
  const db = await openDatabase();
  const transaction = db.transaction(STORES, "readwrite");
  STORES.forEach((name) => transaction.objectStore(name).clear());
  await transactionDone(transaction);
}
