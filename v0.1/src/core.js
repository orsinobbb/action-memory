export const SCHEMA_VERSION = 1;

export const STATUS_LABELS = Object.freeze({
  inbox: "收件匣",
  planned: "已規劃",
  active: "進行中",
  waiting: "等待中",
  done: "已完成",
  archived: "已封存",
  note: "備忘"
});

export const RELATION_LABELS = Object.freeze({
  parent_of: "父任務",
  blocks: "會阻擋",
  waiting_for: "等待此項",
  related_to: "相關",
  derived_from: "衍生自"
});

const CLOSED_STATUSES = new Set(["done", "archived", "note"]);

function fallback(value, alternative) {
  return value === null || value === undefined ? alternative : value;
}

export function createId(prefix = "id") {
  const generated = globalThis.crypto?.randomUUID?.();
  const uuid = fallback(generated, `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return `${prefix}_${uuid}`;
}

export function createTask({ title, dueAt, status, waitingFor, now = new Date(), id = createId("task") }) {
  const timestamp = now.toISOString();
  return {
    id,
    title: title.trim(),
    note: "",
    nextAction: "",
    status: fallback(status, dueAt ? "planned" : "inbox"),
    importance: "unset",
    dueAt: dueAt || undefined,
    remindAt: undefined,
    waitingFor: waitingFor || undefined,
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: undefined,
    version: 1
  };
}

export function makeEvent({ entityId, type, summary, actor = "user", patch, now = new Date(), id = createId("event"), correlationId }) {
  return {
    id,
    entityId,
    type,
    at: now.toISOString(),
    actor,
    summary,
    ...(patch && Object.keys(patch).length ? { patch } : {}),
    ...(correlationId ? { correlationId } : {})
  };
}

export function diffTask(before, after) {
  const ignored = new Set(["updatedAt", "version"]);
  const keys = new Set([...Object.keys(fallback(before, {})), ...Object.keys(fallback(after, {}))]);
  const patch = {};
  for (const key of keys) {
    if (ignored.has(key)) continue;
    const oldValue = before?.[key];
    const newValue = after?.[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      patch[key] = { before: fallback(oldValue, null), after: fallback(newValue, null) };
    }
  }
  return patch;
}

export function startOfDay(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function endOfDay(value = new Date()) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

export function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

export function dateKey(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function fromDateTimeLocal(value) {
  return value ? new Date(value).toISOString() : undefined;
}

export function isOpen(task) {
  return !CLOSED_STATUSES.has(task.status);
}

export function computeDashboard(tasks, now = new Date()) {
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const weekEnd = endOfDay(addDays(now, 7));
  const open = tasks.filter(isOpen);

  const overdue = open.filter((task) => task.dueAt && new Date(task.dueAt) < now);
  const today = open.filter((task) => {
    const due = task.dueAt && new Date(task.dueAt) >= now && new Date(task.dueAt) <= todayEnd;
    const remind = task.remindAt && new Date(task.remindAt) >= todayStart && new Date(task.remindAt) <= todayEnd;
    return Boolean(due || remind);
  });
  const waiting = open.filter((task) => task.status === "waiting");
  const inbox = open.filter((task) => task.status === "inbox");
  const upcoming = open.filter((task) => {
    if (!task.dueAt) return false;
    const due = new Date(task.dueAt);
    return due > todayEnd && due <= weekEnd;
  });

  const attentionMap = new Map();
  [...overdue, ...today, ...open.filter((task) => task.importance === "focus")]
    .forEach((task) => attentionMap.set(task.id, task));
  const attention = [...attentionMap.values()].sort((a, b) => taskSortValue(a, now) - taskSortValue(b, now));

  return { overdue, today, waiting, inbox, upcoming: sortTasks(upcoming, now), attention };
}

function taskSortValue(task, now) {
  const importance = fallback({ focus: -3, normal: -1, unset: 0, low: 2 }[task.importance], 0);
  const due = task.dueAt ? Math.max(-1_000_000_000, new Date(task.dueAt).getTime() - now.getTime()) / 86_400_000 : 1000;
  return importance * 10 + due;
}

export function sortTasks(tasks, now = new Date()) {
  return [...tasks].sort((a, b) => taskSortValue(a, now) - taskSortValue(b, now) || new Date(b.updatedAt) - new Date(a.updatedAt));
}

export function filterTasks(tasks, filter = "open", query = "") {
  const normalized = query.trim().toLocaleLowerCase("zh-Hant");
  return tasks.filter((task) => {
    const statusMatch = {
      open: isOpen(task),
      inbox: task.status === "inbox",
      waiting: task.status === "waiting",
      done: task.status === "done",
      all: task.status !== "archived"
    }[filter];
    const acceptedStatus = fallback(statusMatch, true);
    if (!acceptedStatus) return false;
    if (!normalized) return true;
    const haystack = [task.title, task.note, task.nextAction, task.waitingFor, ...fallback(task.tags, [])]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-Hant");
    return haystack.includes(normalized);
  });
}

export function describeTime(task, now = new Date()) {
  const formatter = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  if (task.status === "waiting") {
    const days = Math.max(0, Math.floor((now - new Date(task.updatedAt)) / 86_400_000));
    return { text: task.waitingFor ? `等待 ${task.waitingFor} · ${days} 天` : `已等待 ${days} 天`, tone: "waiting" };
  }
  if (task.dueAt) {
    const due = new Date(task.dueAt);
    if (due < now) return { text: `已逾期 · ${formatter.format(due)}`, tone: "danger" };
    if (dateKey(due) === dateKey(now)) return { text: `今天 ${due.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })} 截止`, tone: "normal" };
    return { text: `${formatter.format(due)} 截止`, tone: "normal" };
  }
  if (task.remindAt) return { text: `${formatter.format(new Date(task.remindAt))} 再提醒`, tone: "normal" };
  return { text: fallback(STATUS_LABELS[task.status], task.status), tone: "normal" };
}

export function summarizeTaskChange(before, after) {
  if (before.status !== after.status) {
    if (after.status === "done") return { type: "completed", summary: `完成「${after.title}」` };
    if (before.status === "done") return { type: "reopened", summary: `重新開啟「${after.title}」` };
    return { type: "status_changed", summary: `狀態由「${STATUS_LABELS[before.status]}」改為「${STATUS_LABELS[after.status]}」` };
  }
  if (before.remindAt !== after.remindAt) return { type: "reminder_changed", summary: `更新「${after.title}」的提醒時間` };
  return { type: "edited", summary: `更新「${after.title}」` };
}

export function backupPayload(data) {
  return {
    tasks: [...data.tasks].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...data.relations].sort((a, b) => a.id.localeCompare(b.id)),
    events: [...data.events].sort((a, b) => a.id.localeCompare(b.id))
  };
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createBackup(data, now = new Date()) {
  const payload = backupPayload(data);
  const checksum = await sha256(JSON.stringify(payload));
  return { schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), checksum: `sha256:${checksum}`, payload };
}

export async function validateBackup(backup) {
  if (!backup || backup.schemaVersion !== SCHEMA_VERSION || !backup.payload) return { valid: false, reason: "不支援的備份格式或版本" };
  const { tasks, relations, events } = backup.payload;
  if (![tasks, relations, events].every(Array.isArray)) return { valid: false, reason: "備份缺少必要資料集合" };
  const checksum = `sha256:${await sha256(JSON.stringify(backupPayload(backup.payload)))}`;
  if (checksum !== backup.checksum) return { valid: false, reason: "備份校驗失敗，檔案可能已損毀" };
  return { valid: true };
}

export function previewImport(current, incoming) {
  const existing = new Map(current.tasks.map((task) => [task.id, task]));
  let added = 0;
  let newer = 0;
  let unchanged = 0;
  for (const task of incoming.tasks) {
    const local = existing.get(task.id);
    if (!local) added += 1;
    else if (fallback(task.version, 1) > fallback(local.version, 1)) newer += 1;
    else unchanged += 1;
  }
  return { added, newer, unchanged, incomingTotal: incoming.tasks.length };
}

export function escapeCsv(value) {
  const string = value == null ? "" : String(value);
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export function tasksToCsv(tasks) {
  const headers = ["id", "title", "status", "importance", "nextAction", "dueAt", "remindAt", "waitingFor", "tags", "createdAt", "updatedAt"];
  const rows = tasks.map((task) => headers.map((key) => escapeCsv(key === "tags" ? fallback(task.tags, []).join("|") : task[key])).join(","));
  return `\uFEFF${headers.join(",")}\r\n${rows.join("\r\n")}`;
}
