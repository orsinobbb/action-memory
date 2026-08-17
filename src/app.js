import {
  RELATION_LABELS,
  RECURRENCE_LABELS,
  STATUS_LABELS,
  buildTaskLink,
  computeDashboard,
  createBackup,
  createId,
  createNextOccurrence,
  createTask,
  dateKey,
  describeTime,
  diffTask,
  filterTasks,
  fromDateTimeLocal,
  makeEvent,
  moveTaskToTrash,
  previewImport,
  rescheduleTask,
  restoreTaskFromTrash,
  sortTasks,
  summarizeTaskChange,
  taskIdFromHash,
  taskPreviewFromHash,
  taskToIcs,
  tasksToCsv,
  toDateTimeLocal,
  validateBackup
} from "./core.js?v=9";
import {
  addEvent,
  addRelation,
  addTask,
  completeRecurringTask,
  getAllData,
  getSetting,
  importData,
  removeRelation,
  setSetting,
  updateTask
} from "./db.js?v=9";
import { GOOGLE_SETUP_FILES, GoogleBackendBridge, normalizeGoogleBackendUrl, summarizeGoogleSetup } from "./google-backend.js?v=11";
import { calculatorReducer, createCalculatorState } from "./calculator.js?v=9";

const GOOGLE_BACKEND_SETTING = "googleBackend";
const GOOGLE_SETUP_STORAGE = "action-memory-google-setup-v1";

const state = {
  tasks: [],
  relations: [],
  events: [],
  view: "dashboard",
  filter: "open",
  query: "",
  captureMode: null,
  pendingImport: null,
  deferredInstallPrompt: null,
  calculator: createCalculatorState(),
  googleBackend: null,
  googleBridge: null,
  googleSetup: loadGoogleSetup()
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function renderCalculator() {
  $("#calculator-display").textContent = state.calculator.display;
  $$("[data-calculator-action='operator']").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.calculatorValue === state.calculator.pendingOperator);
  });
}

function useCalculator(action) {
  state.calculator = calculatorReducer(state.calculator, action);
  renderCalculator();
}

async function copyCalculatorResult() {
  if (state.calculator.display === "錯誤") return;
  try {
    await navigator.clipboard.writeText(state.calculator.display);
    showToast("計算結果已複製");
  } catch {
    showToast("瀏覽器未允許自動複製");
  }
}

function handleCalculatorKeyboard(event) {
  if (!$("#calculator-dialog").open) return;
  const operatorMap = { "+": "+", "-": "−", "*": "×", "/": "÷" };
  let action = null;
  if (/^\d$/.test(event.key)) action = { type: "digit", value: event.key };
  else if (operatorMap[event.key]) action = { type: "operator", value: operatorMap[event.key] };
  else if (event.key === ".") action = { type: "decimal" };
  else if (event.key === "%") action = { type: "percent" };
  else if (event.key === "Enter" || event.key === "=") action = { type: "equals" };
  else if (event.key === "Backspace") action = { type: "backspace" };
  else if (event.key === "Delete") action = { type: "clear" };
  if (!action) return;
  event.preventDefault();
  useCalculator(action);
}

function localDateTimeForDay(offset = 0, hour = 18) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function formatDateHeader(date = new Date()) {
  return new Intl.DateTimeFormat("zh-TW", { month: "long", day: "numeric", weekday: "short" }).format(date);
}

function formatEventTime(value) {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(value));
}

async function refresh() {
  const data = await getAllData();
  state.tasks = data.tasks;
  state.relations = data.relations;
  state.events = data.events;
  render();
}

function render() {
  renderDashboard();
  renderMemory();
  renderTimeline($("#timeline-list"), state.events);
  updateNotificationStatus();
}

function emptyState(message) {
  const fragment = $("#empty-template").content.cloneNode(true);
  fragment.querySelector("p").textContent = message;
  return fragment;
}

function renderDashboard() {
  const dashboard = computeDashboard(state.tasks);
  const cards = [
    { label: "逾期", count: dashboard.overdue.length, filter: "open", tone: dashboard.overdue.length ? "danger" : "" },
    { label: "今天", count: dashboard.today.length, filter: "open", tone: "" },
    { label: "等待", count: dashboard.waiting.length, filter: "waiting", tone: dashboard.waiting.length ? "waiting" : "" },
    { label: "收件匣", count: dashboard.inbox.length, filter: "inbox", tone: "" }
  ];
  const statGrid = $("#stat-grid");
  statGrid.replaceChildren(...cards.map((item) => {
    const button = element("button", `stat-card ${item.tone}`.trim());
    button.type = "button";
    button.dataset.filter = item.filter;
    button.append(element("strong", "", String(item.count)), element("span", "", item.label));
    return button;
  }));

  $("#attention-count").textContent = String(dashboard.attention.length);
  renderTaskList($("#attention-list"), dashboard.attention, "目前沒有逾期、今日截止或焦點事項。");
  renderTaskList($("#upcoming-list"), dashboard.upcoming, "未來 7 天沒有已排程事項。");
  $("#inbox-summary").textContent = dashboard.inbox.length ? `收件匣有 ${dashboard.inbox.length} 件尚未整理` : "收件匣是空的";
  $("#greeting").textContent = dashboard.attention.length
    ? `今天先處理 ${dashboard.attention.length} 件真正需要注意的事。`
    : "目前沒有急迫事項，可以安心規劃下一步。";
}

function renderMemory() {
  const headings = {
    open: "進行中的事項",
    inbox: "尚未整理的記憶",
    waiting: "正在等待的事項",
    done: "已完成的事項",
    all: "所有記憶",
    deleted: "可還原的事項"
  };
  const filtered = sortTasks(filterTasks(state.tasks, state.filter, state.query));
  $("#memory-heading").textContent = state.query ? `搜尋「${state.query}」` : headings[state.filter];
  $("#memory-count").textContent = String(filtered.length);
  renderTaskList($("#memory-list"), filtered, state.query ? "找不到符合的內容。" : "這裡目前沒有事項。", true);
}

function renderTaskList(container, tasks, emptyMessage, showAll = false) {
  container.replaceChildren();
  const visible = showAll ? tasks : tasks.slice(0, 6);
  if (!visible.length) {
    container.append(emptyState(emptyMessage));
    return;
  }
  visible.forEach((task) => container.append(createTaskCard(task)));
}

function createTaskCard(task) {
  const card = element("article", `task-card${task.status === "done" ? " is-done" : ""}${task.deletedAt ? " is-deleted" : ""}`);
  card.dataset.taskId = task.id;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const complete = element("button", "complete-button");
  complete.type = "button";
  complete.dataset.action = task.deletedAt ? "restore" : "toggle-complete";
  complete.classList.toggle("is-restore", Boolean(task.deletedAt));
  if (task.deletedAt) complete.textContent = "↶";
  complete.setAttribute("aria-label", task.deletedAt ? "還原任務" : task.status === "done" ? "重新開啟" : "標示完成");

  const body = element("div", "task-card-body");
  body.append(element("p", "task-card-title", task.title));
  if (task.nextAction) body.append(element("p", "task-card-next", `下一步：${task.nextAction}`));
  const meta = element("div", "task-card-meta");
  const time = describeTime(task);
  meta.append(element("span", `meta-pill ${time.tone === "normal" ? "" : time.tone}`.trim(), time.text));
  if (task.importance === "focus") meta.append(element("span", "meta-pill", "焦點"));
  if (task.recurrence && task.recurrence !== "none") meta.append(element("span", "meta-pill", RECURRENCE_LABELS[task.recurrence]));
  if (task.tags?.[0]) meta.append(element("span", "meta-pill", `#${task.tags[0]}`));
  body.append(meta);
  card.append(complete, body, element("span", "task-chevron", "›"));

  card.addEventListener("click", async (event) => {
    if (event.target.closest('[data-action="restore"]')) {
      event.stopPropagation();
      await restoreDeletedTask(task);
      return;
    }
    if (event.target.closest('[data-action="toggle-complete"]')) {
      event.stopPropagation();
      await toggleComplete(task);
      return;
    }
    if (task.deletedAt) return showToast("請先還原，再繼續編輯");
    openTaskDialog(task.id);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (task.deletedAt) return showToast("請先還原，再繼續編輯");
      openTaskDialog(task.id);
    }
  });
  return card;
}

async function toggleComplete(task) {
  const now = new Date();
  const nextStatus = task.status === "done" ? "active" : "done";
  const next = {
    ...task,
    status: nextStatus,
    completedAt: nextStatus === "done" ? now.toISOString() : undefined,
    updatedAt: now.toISOString(),
    version: (task.version === null || task.version === undefined ? 1 : task.version) + 1
  };
  const spawned = await saveTaskChange(task, next, now);
  showToast(spawned
    ? `已完成，下一次已排到 ${dateKey(spawned.dueAt)}`
    : nextStatus === "done" ? "已完成，演化紀錄已保存" : "任務已重新開啟");
  await refresh();
}

async function saveTaskChange(previous, next, now = new Date()) {
  const patch = diffTask(previous, next);
  const change = summarizeTaskChange(previous, next);
  const eventRecord = makeEvent({ entityId: next.id, ...change, patch, now });
  if (previous.status !== "done" && next.status === "done" && (next.recurrence || "none") !== "none") {
    const nextOccurrence = createNextOccurrence(next, now);
    if (!nextOccurrence) {
      await updateTask(next, eventRecord);
      return null;
    }
    const relation = {
      id: createId("relation"),
      fromId: nextOccurrence.id,
      toId: next.id,
      type: "derived_from",
      createdAt: now.toISOString()
    };
    const nextEvent = makeEvent({
      entityId: nextOccurrence.id,
      type: "recurrence_created",
      actor: "system",
      summary: `依「${next.title}」建立下一次週期任務`,
      now
    });
    await completeRecurringTask(next, eventRecord, nextOccurrence, nextEvent, relation);
    return nextOccurrence;
  }
  await updateTask(next, eventRecord);
  return null;
}

function renderTimeline(container, events) {
  container.replaceChildren();
  const sorted = [...events].sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!sorted.length) {
    container.append(emptyState("開始記錄後，每次演化都會出現在這裡。"));
    return;
  }
  sorted.slice(0, 120).forEach((event) => {
    const item = element("article", "timeline-item");
    const dot = element("span", "timeline-dot", event.actor === "user" ? "你" : event.actor === "import" ? "匯" : "系");
    const content = element("div", "timeline-content");
    const task = state.tasks.find((candidate) => candidate.id === event.entityId);
    content.append(element("strong", "", event.summary));
    if (task && !event.summary.includes(task.title)) content.append(element("p", "", task.title));
    content.append(element("time", "", formatEventTime(event.at)));
    item.append(dot, content);
    container.append(item);
  });
}

function setView(view, { filter } = {}) {
  state.view = view;
  if (filter) state.filter = filter;
  $$(".view").forEach((node) => node.classList.toggle("is-active", node.dataset.view === view));
  $$(".nav-item").forEach((node) => node.classList.toggle("is-active", node.dataset.target === view));
  const titles = { dashboard: "今日戰情", memory: "行動記憶", timeline: "演化時間軸" };
  $("#view-title").textContent = titles[view];
  $("#search-button").hidden = view === "timeline";
  if (view === "memory") {
    $$(".filter-chip").forEach((node) => node.classList.toggle("is-active", node.dataset.filter === state.filter));
    renderMemory();
  }
  $("#app-main").focus({ preventScroll: true });
  scrollTo({ top: 0, behavior: "smooth" });
}

function resetCapture() {
  state.captureMode = null;
  $("#capture-form").reset();
  $$(".quick-date").forEach((node) => node.classList.remove("is-active"));
  $("#capture-hint").textContent = "未指定日期，會先放進收件匣。";
}

async function submitCapture(event) {
  event.preventDefault();
  const title = $("#capture-title").value.trim();
  if (!title) return;
  const pickedDate = $("#capture-date").value;
  let dueAt;
  let status;
  let waitingFor;
  if (state.captureMode === "today") dueAt = localDateTimeForDay(0);
  if (state.captureMode === "tomorrow") dueAt = localDateTimeForDay(1);
  if (pickedDate) {
    const date = new Date(`${pickedDate}T18:00:00`);
    dueAt = date.toISOString();
  }
  if (state.captureMode === "waiting") {
    status = "waiting";
    waitingFor = "待補充等待對象";
  }
  const task = createTask({ title, dueAt, status, waitingFor });
  const eventRecord = makeEvent({ entityId: task.id, type: "created", summary: `記下「${task.title}」` });
  await addTask(task, eventRecord);
  $("#capture-dialog").close();
  resetCapture();
  showToast("已存進記憶庫");
  await refresh();
}

function openTaskDialog(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  $("#task-id").value = task.id;
  $("#task-title").value = task.title;
  $("#task-status").value = task.status;
  $("#task-importance").value = task.importance || "unset";
  $("#task-next-action").value = task.nextAction || "";
  $("#task-note").value = task.note || "";
  $("#task-due-at").value = toDateTimeLocal(task.dueAt);
  $("#task-remind-at").value = toDateTimeLocal(task.remindAt);
  $("#task-waiting-for").value = task.waitingFor || "";
  $("#task-recurrence").value = task.recurrence || "none";
  $("#task-tags").value = (task.tags || []).join(", ");
  $("#save-state").textContent = `版本 ${task.version === null || task.version === undefined ? 1 : task.version}`;
  renderTaskRelations(task);
  renderTimeline($("#task-timeline"), state.events.filter((item) => item.entityId === task.id));
  $("#task-dialog").showModal();
}

function openLinkedTask() {
  const taskId = taskIdFromHash(location.hash);
  if (!taskId) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    const preview = taskPreviewFromHash(location.hash);
    if (!preview) {
      showToast("此裝置尚無這筆任務；請回到建立任務的拾記，或先匯入備份");
      return;
    }
    $("#linked-task-title").textContent = preview.title;
    $("#linked-task-time").textContent = preview.when
      ? new Intl.DateTimeFormat("zh-TW", {
        year: "numeric", month: "long", day: "numeric", weekday: "short",
        hour: "2-digit", minute: "2-digit", hour12: false
      }).format(new Date(preview.when))
      : "未指定日期";
    $("#linked-task-dialog").showModal();
    return;
  }
  if ($("#task-dialog").open) $("#task-dialog").close();
  openTaskDialog(task.id);
}

function readTaskForm(previous) {
  const now = new Date();
  const status = $("#task-status").value;
  return {
    ...previous,
    title: $("#task-title").value.trim(),
    status,
    importance: $("#task-importance").value,
    nextAction: $("#task-next-action").value.trim(),
    note: $("#task-note").value.trim(),
    dueAt: fromDateTimeLocal($("#task-due-at").value),
    remindAt: fromDateTimeLocal($("#task-remind-at").value),
    waitingFor: $("#task-waiting-for").value.trim() || undefined,
    recurrence: $("#task-recurrence").value,
    tags: $("#task-tags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    completedAt: status === "done" ? (previous.completedAt || now.toISOString()) : undefined,
    updatedAt: now.toISOString(),
    version: (previous.version === null || previous.version === undefined ? 1 : previous.version) + 1
  };
}

async function submitTask(event) {
  event.preventDefault();
  const previous = state.tasks.find((item) => item.id === $("#task-id").value);
  if (!previous) return;
  const next = readTaskForm(previous);
  if (!next.title) return;
  const patch = diffTask(previous, next);
  if (!Object.keys(patch).length) {
    $("#task-dialog").close();
    return;
  }
  const spawned = await saveTaskChange(previous, next);
  $("#task-dialog").close();
  showToast(spawned ? `變更已儲存，下一次排到 ${dateKey(spawned.dueAt)}` : "變更與演化紀錄已儲存");
  await refresh();
}

function renderTaskRelations(task) {
  const list = $("#relation-list");
  list.replaceChildren();
  const taskRelations = state.relations.filter((relation) => relation.fromId === task.id || relation.toId === task.id);
  if (!taskRelations.length) list.append(element("p", "capture-hint", "尚未建立關聯。"));
  taskRelations.forEach((relation) => {
    const outgoing = relation.fromId === task.id;
    const targetId = outgoing ? relation.toId : relation.fromId;
    const target = state.tasks.find((item) => item.id === targetId);
    if (!target) return;
    const item = element("div", "relation-item");
    item.append(element("span", "", `${outgoing ? RELATION_LABELS[relation.type] : "被關聯"} · ${target.title}`));
    const remove = element("button", "", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除關聯");
    remove.addEventListener("click", () => deleteRelation(relation, task));
    item.append(remove);
    list.append(item);
  });

  const targetSelect = $("#relation-target");
  targetSelect.replaceChildren(element("option", "", "選擇另一件事"));
  targetSelect.firstChild.value = "";
  state.tasks.filter((item) => item.id !== task.id && item.status !== "archived" && !item.deletedAt).forEach((item) => {
    const option = element("option", "", item.title);
    option.value = item.id;
    targetSelect.append(option);
  });
}

async function createRelationForCurrentTask() {
  const fromId = $("#task-id").value;
  const toId = $("#relation-target").value;
  const type = $("#relation-type").value;
  if (!fromId || !toId) return showToast("請先選擇要關聯的事項");
  if (state.relations.some((item) => item.fromId === fromId && item.toId === toId && item.type === type)) return showToast("這個關聯已存在");
  const target = state.tasks.find((item) => item.id === toId);
  const relation = { id: createId("relation"), fromId, toId, type, createdAt: new Date().toISOString() };
  const eventRecord = makeEvent({ entityId: fromId, type: "relation_added", summary: `新增「${RELATION_LABELS[type]}」關聯：${target.title}` });
  await addRelation(relation, eventRecord);
  await refresh();
  renderTaskRelations(state.tasks.find((item) => item.id === fromId));
  renderTimeline($("#task-timeline"), state.events.filter((item) => item.entityId === fromId));
  showToast("關聯已建立");
}

async function deleteRelation(relation, currentTask) {
  const targetId = relation.fromId === currentTask.id ? relation.toId : relation.fromId;
  const target = state.tasks.find((item) => item.id === targetId);
  const targetTitle = target?.title || "未知任務";
  const eventRecord = makeEvent({ entityId: currentTask.id, type: "relation_removed", summary: `移除與「${targetTitle}」的關聯` });
  await removeRelation(relation.id, eventRecord);
  await refresh();
  renderTaskRelations(state.tasks.find((item) => item.id === currentTask.id));
  renderTimeline($("#task-timeline"), state.events.filter((item) => item.entityId === currentTask.id));
}

async function deleteCurrentTask() {
  const task = state.tasks.find((item) => item.id === $("#task-id").value);
  if (!task || !confirm(`將「${task.title}」移到回收桶？之後仍可還原。`)) return;
  const now = new Date();
  const next = moveTaskToTrash(task, now);
  const change = summarizeTaskChange(task, next);
  await updateTask(next, makeEvent({ entityId: task.id, ...change, patch: diffTask(task, next), now }));
  $("#task-dialog").close();
  showToast("已移到回收桶，可隨時還原");
  await refresh();
}

async function restoreDeletedTask(task) {
  const now = new Date();
  const next = restoreTaskFromTrash(task, now);
  const change = summarizeTaskChange(task, next);
  await updateTask(next, makeEvent({ entityId: task.id, ...change, patch: diffTask(task, next), now }));
  showToast("任務已還原");
  await refresh();
}

async function postponeCurrentTask(offset, label) {
  const task = state.tasks.find((item) => item.id === $("#task-id").value);
  if (!task) return;
  const now = new Date();
  const draft = readTaskForm(task);
  if (!draft.title) return showToast("標題不能空白");
  const next = rescheduleTask({ ...draft, version: task.version }, localDateTimeForDay(offset), now);
  await updateTask(next, makeEvent({
    entityId: task.id,
    type: "postponed",
    summary: `將「${task.title}」排到${label}`,
    patch: diffTask(task, next),
    now
  }));
  $("#task-dialog").close();
  showToast(`已排到${label}`);
  await refresh();
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportJson() {
  await addEvent(makeEvent({ entityId: "system", type: "exported", summary: "匯出完整 JSON 備份" }));
  await refresh();
  const backup = await createBackup({ tasks: state.tasks, relations: state.relations, events: state.events });
  downloadFile(`拾記備份-${dateKey(new Date())}.json`, JSON.stringify(backup, null, 2), "application/json;charset=utf-8");
  showToast("完整備份已匯出");
}

async function exportCsv() {
  await addEvent(makeEvent({ entityId: "system", type: "exported", summary: "匯出任務 CSV" }));
  await refresh();
  downloadFile(`拾記任務-${dateKey(new Date())}.csv`, tasksToCsv(state.tasks), "text/csv;charset=utf-8");
  showToast("CSV 已匯出");
}

async function loadImportFile(file) {
  const preview = $("#import-preview");
  try {
    const backup = JSON.parse(await file.text());
    await showImportPreview(backup, "備份校驗通過");
  } catch (error) {
    state.pendingImport = null;
    preview.replaceChildren(element("strong", "", `無法匯入：${error.message}`));
    preview.hidden = false;
  } finally {
    $("#import-json-input").value = "";
  }
}

async function showImportPreview(backup, title) {
  const preview = $("#import-preview");
  const validation = await validateBackup(backup);
  if (!validation.valid) throw new Error(validation.reason);
  state.pendingImport = backup;
  const counts = previewImport({ tasks: state.tasks }, backup.payload);
  preview.replaceChildren();
  preview.append(element("strong", "", title));
  preview.append(element("p", "", `共 ${counts.incomingTotal} 件：新增 ${counts.added}、較新版本 ${counts.newer}、不變 ${counts.unchanged}。`));
  const actions = element("div", "preview-actions");
  const merge = element("button", "secondary-button", "安全合併");
  merge.type = "button";
  merge.addEventListener("click", () => applyImport("merge"));
  const replace = element("button", "danger-button", "完整取代");
  replace.type = "button";
  replace.addEventListener("click", () => applyImport("replace"));
  actions.append(merge, replace);
  preview.append(actions);
  preview.hidden = false;
}

function setGoogleBackendStatus(message, isError = false) {
  const node = $("#google-backend-status");
  node.textContent = message;
  node.classList.toggle("is-error", isError);
}

function loadGoogleSetup() {
  try {
    const saved = JSON.parse(localStorage.getItem(GOOGLE_SETUP_STORAGE) || "{}");
    return {
      projectOpened: Boolean(saved.projectOpened),
      copiedFiles: Array.isArray(saved.copiedFiles) ? saved.copiedFiles.filter((file) => GOOGLE_SETUP_FILES.includes(file)) : []
    };
  } catch {
    return { projectOpened: false, copiedFiles: [] };
  }
}

function saveGoogleSetup() {
  localStorage.setItem(GOOGLE_SETUP_STORAGE, JSON.stringify(state.googleSetup));
  renderGoogleSetup();
}

function renderGoogleSetup() {
  const url = $("#google-backend-url").value;
  const progress = summarizeGoogleSetup({
    ...state.googleSetup,
    url,
    initialized: Boolean(state.googleBackend && state.googleBackend.initialized)
  });
  $("#google-setup-progress").textContent = `${progress.completed} / ${progress.total}`;
  $$("[data-google-step]").forEach((step) => {
    step.classList.toggle("is-complete", Boolean(progress.steps[step.dataset.googleStep]));
  });
  $$("[data-google-copy-file]").forEach((button) => {
    const copied = state.googleSetup.copiedFiles.includes(button.dataset.googleCopyFile);
    button.classList.toggle("is-complete", copied);
    button.textContent = copied ? `已複製 ${button.dataset.googleCopyFile}` : `複製 ${button.dataset.googleCopyFile}`;
  });
  const urlCheck = $("#google-backend-url-check");
  if (!url.trim()) {
    urlCheck.textContent = "等待貼上結尾為 /exec 的部署網址。";
    urlCheck.classList.remove("is-valid", "is-error");
  } else if (progress.published) {
    urlCheck.textContent = "網址格式正確，可以連接並驗證。";
    urlCheck.classList.add("is-valid");
    urlCheck.classList.remove("is-error");
  } else {
    urlCheck.textContent = "這不是已發布的 /exec 網址，請回到 Apps Script 複製網頁應用程式網址。";
    urlCheck.classList.add("is-error");
    urlCheck.classList.remove("is-valid");
  }
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("瀏覽器不允許複製，請改用 GitHub 原始檔");
}

async function copyGoogleSetupFile(button) {
  const file = button.dataset.googleCopyFile;
  button.disabled = true;
  try {
    const response = await fetch(`./backend/apps-script/${file}?v=9`, { cache: "no-store" });
    if (!response.ok) throw new Error(`讀取 ${file} 失敗`);
    await copyText(await response.text());
    if (!state.googleSetup.copiedFiles.includes(file)) state.googleSetup.copiedFiles.push(file);
    saveGoogleSetup();
    showToast(`${file} 已複製，可以貼到 Apps Script`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function applyGoogleHealth(health) {
  const connected = Boolean(health && health.initialized);
  $("#google-backup-button").disabled = !connected;
  $("#google-restore-button").disabled = !connected || !health.hasBackup;
  const sheetLink = $("#google-sheet-link");
  sheetLink.hidden = !connected || !health.spreadsheetUrl;
  if (health.spreadsheetUrl) sheetLink.href = health.spreadsheetUrl;
  $("#sync-state").innerHTML = connected
    ? `<i></i> 本機優先 · Google 版本 ${health.revision}`
    : "<i></i> 資料僅儲存在這台裝置";
  setGoogleBackendStatus(connected
    ? `Google 後端已驗證；雲端版本 ${health.revision}${health.hasBackup ? "，已有備份" : "，尚無備份"}。`
    : "Google 後端尚未初始化；不影響本機使用。");
  renderGoogleSetup();
}

async function saveGoogleState(health) {
  state.googleBackend = {
    url: normalizeGoogleBackendUrl($("#google-backend-url").value),
    revision: health.revision,
    initialized: health.initialized,
    hasBackup: health.hasBackup,
    spreadsheetUrl: health.spreadsheetUrl || null
  };
  await setSetting(GOOGLE_BACKEND_SETTING, state.googleBackend);
  applyGoogleHealth(state.googleBackend);
}

async function connectGoogleBackend() {
  const button = $("#google-connect-button");
  button.disabled = true;
  setGoogleBackendStatus("已另開 Google 授權分頁；完成後請回到拾記，此頁會自動驗證。授權分頁請保持開啟。");
  try {
    if (state.googleBridge) state.googleBridge.close();
    state.googleBridge = await new GoogleBackendBridge().connect($("#google-backend-url").value);
    const health = await state.googleBridge.request("initialize");
    await saveGoogleState(health);
    $("#google-setup-guide").open = false;
    showToast("Google 後端已連接並通過檢查");
  } catch (error) {
    setGoogleBackendStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function backupToGoogle() {
  const button = $("#google-backup-button");
  button.disabled = true;
  setGoogleBackendStatus("正在建立校驗備份並送往 Google…");
  try {
    if (!state.googleBridge || !state.googleBridge.ready) throw new Error("請先按「連接並驗證」重新驗證 Google 授權");
    const backup = await createBackup({ tasks: state.tasks, relations: state.relations, events: state.events });
    const result = await state.googleBridge.request("push", {
      backup,
      baseRevision: state.googleBackend.revision,
      deviceId: "web-" + window.location.hostname,
      requestId: createId("backup")
    });
    if (result.conflict) throw new Error(`雲端已有版本 ${result.revision}，本次未覆寫；請先讀取雲端備份。`);
    await saveGoogleState(result);
    showToast(`Google 備份已送達（版本 ${result.revision}）`);
  } catch (error) {
    setGoogleBackendStatus(error.message, true);
    button.disabled = false;
  }
}

async function restoreFromGoogle() {
  const button = $("#google-restore-button");
  button.disabled = true;
  setGoogleBackendStatus("正在讀取 Google 備份…");
  try {
    if (!state.googleBridge || !state.googleBridge.ready) throw new Error("請先按「連接並驗證」重新驗證 Google 授權");
    const result = await state.googleBridge.request("pull");
    if (!result.backup) throw new Error("Google 後端目前沒有備份");
    await showImportPreview(result.backup, `Google 版本 ${result.revision} 校驗通過`);
    state.googleBackend.revision = result.revision;
    await setSetting(GOOGLE_BACKEND_SETTING, state.googleBackend);
    setGoogleBackendStatus("已讀取雲端備份；請在「本機資料」預覽後選擇安全合併或完整取代。");
  } catch (error) {
    setGoogleBackendStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function applyImport(mode) {
  if (!state.pendingImport) return;
  if (mode === "replace" && !confirm("完整取代會清除目前本機資料，再還原備份。確定繼續？")) return;
  const correlationId = createId("import");
  const eventRecord = makeEvent({
    entityId: "system",
    type: "imported",
    actor: "import",
    summary: mode === "replace" ? "以備份完整取代本機資料" : "安全合併備份資料",
    correlationId
  });
  await importData(state.pendingImport.payload, mode, eventRecord);
  state.pendingImport = null;
  $("#import-preview").hidden = true;
  showToast(mode === "replace" ? "備份已完整還原" : "備份已安全合併");
  await refresh();
}

async function exportCalendar() {
  const task = state.tasks.find((item) => item.id === $("#task-id").value);
  if (!task) return;
  const taskUrl = buildTaskLink(task.id, location, {
    title: task.title,
    when: task.dueAt || task.remindAt
  });
  const content = taskToIcs(task, { taskUrl });
  await addEvent(makeEvent({ entityId: task.id, type: "exported", summary: `匯出行事曆：${task.title}` }));
  await refresh();
  downloadFile(`${task.title.replace(/[\\/:*?"<>|]/g, "-")}.ics`, content, "text/calendar;charset=utf-8");
  showToast("行事曆事件已匯出");
}

function updateNotificationStatus() {
  const node = $("#notification-status");
  const button = $("#notification-button");
  if (!("Notification" in window)) {
    node.textContent = "此瀏覽器不支援通知，請使用加入行事曆功能。";
    button.disabled = true;
    return;
  }
  const messages = {
    granted: "瀏覽器通知已啟用；背景準時性仍受裝置與系統限制。",
    denied: "通知權限已被拒絕，請到瀏覽器網站設定中重新允許。",
    default: "瀏覽器通知尚未啟用。背景通知仍受裝置限制。"
  };
  node.textContent = messages[Notification.permission];
  button.textContent = Notification.permission === "granted" ? "通知已啟用" : "啟用瀏覽器通知";
  button.disabled = Notification.permission === "granted";
}

async function requestNotifications() {
  if (!("Notification" in window)) return;
  const permission = await Notification.requestPermission();
  updateNotificationStatus();
  showToast(permission === "granted" ? "通知已啟用" : "未取得通知權限");
}

function checkDueNotifications() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = new Date();
  state.tasks.filter((task) => task.remindAt && new Date(task.remindAt) <= now && !["done", "archived"].includes(task.status)).forEach((task) => {
    const key = `notified:${task.id}:${task.remindAt}`;
    if (localStorage.getItem(key)) return;
    new Notification(task.title, { body: task.nextAction || "這件事現在需要你的注意。", icon: "./icons/icon.svg", tag: task.id });
    localStorage.setItem(key, now.toISOString());
  });
}

function bindEvents() {
  $("#today-label").textContent = formatDateHeader();
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.target)));
  $("#stat-grid").addEventListener("click", (event) => {
    const card = event.target.closest(".stat-card");
    if (card) setView("memory", { filter: card.dataset.filter });
  });
  $("#review-inbox-button").addEventListener("click", () => setView("memory", { filter: "inbox" }));
  $("#add-task-button").addEventListener("click", () => {
    resetCapture();
    $("#capture-dialog").showModal();
    setTimeout(() => $("#capture-title").focus(), 50);
  });
  $("#capture-form").addEventListener("submit", submitCapture);
  $$(".quick-date").forEach((button) => button.addEventListener("click", () => {
    if (button.classList.contains("date-picker")) {
      $("#capture-date").showPicker?.();
      return;
    }
    state.captureMode = state.captureMode === button.dataset.date ? null : button.dataset.date;
    $$(".quick-date").forEach((node) => node.classList.toggle("is-active", node.dataset.date === state.captureMode));
    const hints = { today: "今天 18:00 截止。", tomorrow: "明天 18:00 截止。", waiting: "先標為等待中，稍後補上等待對象。" };
    $("#capture-hint").textContent = hints[state.captureMode] || "未指定日期，會先放進收件匣。";
  }));
  $("#capture-date").addEventListener("change", (event) => {
    state.captureMode = null;
    $$(".quick-date").forEach((node) => node.classList.remove("is-active"));
    $(".date-picker").classList.toggle("is-active", Boolean(event.target.value));
    $("#capture-hint").textContent = event.target.value ? `${event.target.value} 18:00 截止。` : "未指定日期，會先放進收件匣。";
  });

  $("#task-form").addEventListener("submit", submitTask);
  $("#close-task-button").addEventListener("click", () => $("#task-dialog").close());
  $("#add-relation-button").addEventListener("click", createRelationForCurrentTask);
  $("#delete-task-button").addEventListener("click", deleteCurrentTask);
  $("#calendar-button").addEventListener("click", exportCalendar);
  $$("[data-postpone]").forEach((button) => button.addEventListener("click", () => {
    postponeCurrentTask(Number(button.dataset.postpone), button.dataset.label);
  }));

  $("#task-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderMemory();
  });
  $$(".filter-chip").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    $$(".filter-chip").forEach((node) => node.classList.toggle("is-active", node === button));
    renderMemory();
  }));
  $("#search-button").addEventListener("click", () => {
    setView("memory");
    setTimeout(() => $("#task-search").focus(), 60);
  });

  $("#calculator-button").addEventListener("click", () => {
    renderCalculator();
    $("#calculator-dialog").showModal();
  });
  $("#close-calculator-button").addEventListener("click", () => $("#calculator-dialog").close());
  $("#calculator-keypad").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-calculator-action]");
    if (!button) return;
    useCalculator({ type: button.dataset.calculatorAction, value: button.dataset.calculatorValue });
  });
  $("#calculator-copy-button").addEventListener("click", copyCalculatorResult);
  document.addEventListener("keydown", handleCalculatorKeyboard);

  $("#settings-button").addEventListener("click", () => {
    renderGoogleSetup();
    $("#settings-dialog").showModal();
  });
  $("#close-settings-button").addEventListener("click", () => $("#settings-dialog").close());
  $("#close-linked-task-button").addEventListener("click", () => $("#linked-task-dialog").close());
  $("#dismiss-linked-task-button").addEventListener("click", () => $("#linked-task-dialog").close());
  $("#export-json-button").addEventListener("click", exportJson);
  $("#export-csv-button").addEventListener("click", exportCsv);
  $("#import-json-input").addEventListener("change", (event) => event.target.files[0] && loadImportFile(event.target.files[0]));
  $("#google-script-open-button").addEventListener("click", () => {
    state.googleSetup.projectOpened = true;
    saveGoogleSetup();
  });
  $$("[data-google-copy-file]").forEach((button) => button.addEventListener("click", () => copyGoogleSetupFile(button)));
  $("#google-backend-url").addEventListener("input", renderGoogleSetup);
  $("#google-connect-button").addEventListener("click", connectGoogleBackend);
  $("#google-backup-button").addEventListener("click", backupToGoogle);
  $("#google-restore-button").addEventListener("click", restoreFromGoogle);
  $("#notification-button").addEventListener("click", requestNotifications);
  $("#install-button").addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    $("#install-button").hidden = true;
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    $("#install-button").hidden = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkDueNotifications();
  });
  window.addEventListener("hashchange", openLinkedTask);
}

async function start() {
  bindEvents();
  try {
    state.googleBackend = await getSetting(GOOGLE_BACKEND_SETTING);
    if (state.googleBackend && state.googleBackend.url) {
      $("#google-backend-url").value = state.googleBackend.url;
      setGoogleBackendStatus("已儲存後端網址；請按「連接並驗證」重新驗證 Google 授權與資源狀態。");
    }
    renderGoogleSetup();
    await refresh();
    checkDueNotifications();
    openLinkedTask();
  } catch (error) {
    console.error(error);
    showToast("無法開啟本機資料庫，請確認瀏覽器未封鎖網站儲存空間");
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((error) => console.warn("Service Worker 註冊失敗", error));
  }
}

start();
