const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyLocal,
  detectSensitiveRisks,
  parseModelJson,
  parseProjectOverviewJson,
  redactSensitive,
  sanitizeFilename,
} = require("../src/core");

test("sanitizes filenames without removing Chinese characters", () => {
  assert.equal(sanitizeFilename('工资条:八月?.png'), "工资条_八月_.png");
});

test("classifies common rights material locally", () => {
  const result = classifyLocal("本月工资条和考勤记录", "截图.png");
  assert.equal(result.category, "权益材料");
  assert.equal(result.categoryKey, "rights");
});

test("parses project timeline fields without inventing invalid categories", () => {
  const parsed = parseModelJson('{"category":"自定义会议","title":"周会","projectName":"官网改版","projectConfidence":0.8,"eventDate":"2026-08-05","owners":["张三"],"participants":["李四"]}', ["自定义会议"]);
  assert.equal(parsed.category, "自定义会议");
  assert.equal(parsed.projectName, "官网改版");
  assert.equal(parsed.eventDate, "2026-08-05");
  assert.deepEqual(parsed.owners, ["张三"]);
});

test("detects and redacts common personal identifiers", () => {
  const text = "联系方式 13800138000，邮箱 demo@example.com";
  assert.deepEqual(detectSensitiveRisks(text), ["可能包含手机号", "可能包含邮箱"]);
  assert.equal(redactSensitive(text), "联系方式 [手机号已遮挡]，邮箱 [邮箱已遮挡]");
});

test("parses fenced model JSON and validates category", () => {
  const parsed = parseModelJson('```json\n{"category":"聊天记录","title":"交付确认","summary":"周五提交","tags":["项目A"],"tasks":["提交文件"]}\n```');
  assert.equal(parsed.category, "聊天记录");
  assert.equal(parsed.title, "交付确认");
  assert.deepEqual(parsed.tasks, ["提交文件"]);
});

test("parses AI task deadlines and keeps missing deadlines empty", () => {
  const parsed = parseModelJson('{"category":"任务清单","taskItems":[{"text":"提交修改稿","dueDate":"2026-08-14","owner":"张三"},{"text":"确认预算","dueDate":"下周"}]}');
  assert.deepEqual(parsed.tasks, ["提交修改稿", "确认预算"]);
  assert.deepEqual(parsed.taskItems, [
    { text: "提交修改稿", dueDate: "2026-08-14", owner: "张三" },
    { text: "确认预算", dueDate: "", owner: "" },
  ]);
});

test("parses a structured project progress overview", () => {
  const parsed = parseProjectOverviewJson('```json\n{"currentStage":"开发中","progressSummary":"首页已经完成，正在联调。","completedHighlights":["完成首页"],"nextSteps":["接口联调"],"risks":["截止日期待确认"]}\n```');
  assert.equal(parsed.currentStage, "开发中");
  assert.deepEqual(parsed.nextSteps, ["接口联调"]);
});
