import test from "node:test";
import assert from "node:assert/strict";
import {
  computeDashboard,
  buildTaskLink,
  createBackup,
  createNextOccurrence,
  createTask,
  diffTask,
  filterTasks,
  moveTaskToTrash,
  previewImport,
  rescheduleTask,
  restoreTaskFromTrash,
  taskIdFromHash,
  taskPreviewFromHash,
  taskToIcs,
  tasksToCsv,
  validateBackup
} from "../src/core.js";

const now = new Date("2026-08-12T10:00:00+08:00");

function task(overrides = {}) {
  return {
    id: overrides.id ?? "task-1", // encoding-guard: allow
    title: "測試事項",
    note: "",
    nextAction: "",
    status: "planned",
    importance: "unset",
    tags: [],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    version: 1,
    ...overrides
  };
}

test("快速建立無日期事項會進入收件匣", () => {
  const created = createTask({ title: "  記得回信  ", now, id: "task-fixed" });
  assert.equal(created.title, "記得回信");
  assert.equal(created.status, "inbox");
  assert.equal(created.version, 1);
});

test("有日期的快速事項會進入已規劃", () => {
  const created = createTask({ title: "交月報", dueAt: "2026-08-13T10:00:00.000Z", now, id: "task-fixed" });
  assert.equal(created.status, "planned");
});

test("戰情正確區分逾期、今天、等待、收件匣與未來七天", () => {
  const tasks = [
    task({ id: "overdue", dueAt: "2026-08-12T01:00:00.000Z" }),
    task({ id: "today", dueAt: "2026-08-12T12:00:00.000Z" }),
    task({ id: "waiting", status: "waiting" }),
    task({ id: "inbox", status: "inbox" }),
    task({ id: "upcoming", dueAt: "2026-08-15T10:00:00.000Z" }),
    task({ id: "done", status: "done", dueAt: "2026-08-11T10:00:00.000Z" })
  ];
  const result = computeDashboard(tasks, now);
  assert.deepEqual(result.overdue.map((item) => item.id), ["overdue"]);
  assert.deepEqual(result.today.map((item) => item.id), ["today"]);
  assert.deepEqual(result.waiting.map((item) => item.id), ["waiting"]);
  assert.deepEqual(result.inbox.map((item) => item.id), ["inbox"]);
  assert.deepEqual(result.upcoming.map((item) => item.id), ["upcoming"]);
});

test("搜尋涵蓋標題、內容、下一步與標籤", () => {
  const tasks = [
    task({ id: "a", title: "月報", tags: ["財務"] }),
    task({ id: "b", title: "會議", nextAction: "確認 Orsino 時間" })
  ];
  assert.deepEqual(filterTasks(tasks, "all", "財務").map((item) => item.id), ["a"]);
  assert.deepEqual(filterTasks(tasks, "all", "orsino").map((item) => item.id), ["b"]);
});

test("事件差異不包含 updatedAt 與 version", () => {
  const before = task();
  const after = { ...before, title: "新標題", updatedAt: "2026-08-12T02:00:00.000Z", version: 2 };
  assert.deepEqual(diffTask(before, after), { title: { before: "測試事項", after: "新標題" } });
});

test("備份可校驗且內容被修改後會拒絕", async () => {
  const backup = await createBackup({ tasks: [task()], relations: [], events: [] }, now);
  assert.deepEqual(await validateBackup(backup), { valid: true });
  backup.payload.tasks[0].title = "被修改";
  const invalid = await validateBackup(backup);
  assert.equal(invalid.valid, false);
});

test("相同 JSON 內容不因物件欄位順序不同而產生不同校驗碼", async () => {
  const first = await createBackup({ tasks: [{ id: "a", title: "A" }], relations: [], events: [] }, now);
  const second = await createBackup({ tasks: [{ title: "A", id: "a" }], relations: [], events: [] }, now);
  assert.equal(first.checksum, second.checksum);
});

test("新版備份校驗包含圖片附件索引且仍接受舊備份", async () => {
  const base = { tasks: [], relations: [], events: [] };
  const legacy = await createBackup(base);
  assert.equal((await validateBackup(legacy)).valid, true);

  const withAttachment = await createBackup({
    ...base,
    attachments: [{ id: "attachment_1", taskId: "task_1", checksum: "sha256:image" }]
  });
  assert.equal((await validateBackup(withAttachment)).valid, true);
  withAttachment.payload.attachments[0].checksum = "sha256:changed";
  assert.equal((await validateBackup(withAttachment)).valid, false);
});

test("匯入預覽區分新增、較新與不變", () => {
  const current = { tasks: [task({ id: "same", version: 2 }), task({ id: "older", version: 1 })] };
  const incoming = [task({ id: "same", version: 2 }), task({ id: "older", version: 3 }), task({ id: "new", version: 1 })];
  assert.deepEqual(previewImport(current, { tasks: incoming }), { added: 1, newer: 1, unchanged: 1, incomingTotal: 3 });
});

test("CSV 正確處理逗號、引號與 UTF-8 BOM", () => {
  const csv = tasksToCsv([task({ title: '回覆「A, B」', tags: ["工作", "重要"] })]);
  assert.ok(csv.startsWith("\uFEFFid,title"));
  assert.ok(csv.includes('"回覆「A, B」"'));
  assert.ok(csv.includes("工作|重要"));
});

test("週期任務完成後建立下一次並保留系列關聯", () => {
  const current = task({
    id: "monthly-1",
    recurrence: "monthly",
    dueAt: "2026-01-31T10:00:00.000Z",
    remindAt: "2026-01-31T09:00:00.000Z",
    tags: ["例行"]
  });
  const next = createNextOccurrence(current, now, "monthly-2");
  assert.equal(next.id, "monthly-2");
  assert.equal(next.dueAt, "2026-02-28T10:00:00.000Z");
  assert.equal(next.remindAt, "2026-02-28T09:00:00.000Z");
  assert.equal(next.seriesId, "monthly-1");
  assert.equal(next.previousOccurrenceId, "monthly-1");
  assert.equal(next.status, "planned");
});

test("快速排程會將收件匣轉為已規劃", () => {
  const current = task({ status: "inbox", version: 2 });
  const next = rescheduleTask(current, "2026-08-13T10:00:00.000Z", now);
  assert.equal(next.status, "planned");
  assert.equal(next.version, 3);
  assert.equal(next.dueAt, "2026-08-13T10:00:00.000Z");
});

test("已完成事項重新排程時會回到已規劃", () => {
  const current = task({ status: "done", completedAt: "2026-08-12T01:00:00.000Z" });
  const next = rescheduleTask(current, "2026-08-15T10:00:00.000Z", now);
  assert.equal(next.status, "planned");
  assert.equal(next.completedAt, undefined);
});

test("回收桶任務不進入戰情且可還原原狀態", () => {
  const current = task({ status: "waiting", dueAt: "2026-08-12T01:00:00.000Z" });
  const deleted = moveTaskToTrash(current, now);
  assert.equal(computeDashboard([deleted], now).attention.length, 0);
  assert.deepEqual(filterTasks([deleted], "deleted").map((item) => item.id), [current.id]);
  assert.equal(filterTasks([deleted], "all").length, 0);
  const restored = restoreTaskFromTrash(deleted, now);
  assert.equal(restored.status, "waiting");
  assert.equal(restored.deletedAt, undefined);
});

test("舊任務深連結仍使用穩定識別碼", () => {
  const link = buildTaskLink("task-a/b", { origin: "https://example.com", pathname: "/action-memory/" });
  assert.equal(link, "https://example.com/action-memory/#task=task-a%2Fb");
  assert.equal(taskIdFromHash("#task=task-a%2Fb"), "task-a/b");
});

test("行事曆深連結只攜帶最小任務摘要", () => {
  const link = buildTaskLink("task-1", { origin: "https://example.com", pathname: "/action-memory/" }, {
    title: "買蛋 & 牛奶",
    dueAt: "2026-08-15T04:00:00.000Z",
    note: "不應放進連結"
  });
  assert.equal(link, "https://example.com/action-memory/#task=task-1&title=%E8%B2%B7%E8%9B%8B+%26+%E7%89%9B%E5%A5%B6&when=2026-08-15T04%3A00%3A00.000Z");
  assert.deepEqual(taskPreviewFromHash(new URL(link).hash), {
    id: "task-1",
    title: "買蛋 & 牛奶",
    when: "2026-08-15T04:00:00.000Z"
  });
  assert.equal(link.includes("不應放進連結"), false);
});

test("行事曆事件可回到原任務並保留更新序號與明確提醒時間", () => {
  const current = task({
    id: "calendar-1",
    title: "確認專案節點",
    nextAction: "檢查下一步",
    dueAt: "2026-08-14T10:00:00.000Z",
    remindAt: "2026-08-14T09:00:00.000Z",
    updatedAt: "2026-08-13T08:00:00.000Z",
    version: 3
  });
  const url = "https://example.com/action-memory/#task=calendar-1";
  const ics = taskToIcs(current, { taskUrl: url, now });
  assert.ok(ics.includes(`URL:${url}`));
  assert.ok(ics.includes(`開啟拾記：${url}`));
  assert.ok(ics.includes("SEQUENCE:2"));
  assert.ok(ics.includes("TRIGGER;VALUE=DATE-TIME:20260814T090000Z"));
});
