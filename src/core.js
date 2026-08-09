const crypto = require("node:crypto");

const CATEGORIES = [
  "聊天记录",
  "任务清单",
  "工作文件",
  "权益材料",
  "谈话记录",
  "学习记录",
  "其他",
];

const DEFAULT_CATEGORIES = [
  { id: "chat", name: "聊天记录" },
  { id: "tasks", name: "任务清单" },
  { id: "work", name: "工作文件" },
  { id: "rights", name: "权益材料" },
  { id: "conversation", name: "谈话记录" },
  { id: "learning", name: "学习记录" },
  { id: "other", name: "其他" },
];

function sanitizeFilename(filename) {
  return filename
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "未命名文件";
}

function detectSensitiveRisks(text = "") {
  const checks = [
    ["可能包含手机号", /(?<!\d)1[3-9]\d{9}(?!\d)/],
    ["可能包含身份证号", /(?<!\d)\d{17}[\dXx](?!\d)/],
    ["可能包含邮箱", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
    ["可能包含密码或密钥", /(密码|口令|api\s*key|secret|access[_ -]?key)/i],
    ["可能属于内部或保密资料", /(公司机密|严格保密|内部使用|不得外传|客户名单|商业秘密)/i],
  ];

  return checks.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function redactSensitive(text = "") {
  return text
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号已遮挡]")
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "[身份证号已遮挡]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已遮挡]")
    .slice(0, 12000);
}

function classifyLocal(text = "", filename = "") {
  const source = `${filename}\n${text}`.toLowerCase();
  const rules = [
    ["权益材料", "rights", /(劳动合同|工资条|薪资|考勤|打卡|绩效|社保|公积金|解除劳动|离职证明|调薪)/],
    ["任务清单", "tasks", /(待办|任务清单|todo|截止日期|负责人|完成状态|优先级)/],
    ["谈话记录", "conversation", /(谈话记录|沟通纪要|面谈|录音|访谈|一对一|1on1|one-on-one)/],
    ["学习记录", "learning", /(学习笔记|课程|知识点|读书|培训|教程|复盘学习)/],
    ["聊天记录", "chat", /(聊天记录|微信|飞书|钉钉|群聊|撤回了一条消息|以下是新消息)/],
  ];

  const match = rules.find(([, , pattern]) => pattern.test(source));
  const category = match ? match[0] : "工作文件";
  const categoryKey = match ? match[1] : "work";
  const cleanLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = cleanLines.find((line) => line.length >= 4 && line.length <= 60);
  const baseTitle = filename.replace(/\.[^.]+$/, "");

  return {
    category,
    categoryKey,
    title: (firstLine || baseTitle || "未命名记录").slice(0, 60),
    summary: cleanLines.slice(0, 3).join(" · ").slice(0, 180) || "暂无可识别文字",
    tags: [],
    tasks: [],
    participants: [],
    owners: [],
    decisions: [],
    eventDate: "",
    eventType: "",
    projectName: "",
    projectConfidence: 0,
  };
}

function buildAnalysisPrompt(text, filename, options = {}) {
  const categories = Array.isArray(options.categories) ? options.categories : CATEGORIES;
  const projects = options.projects || [];
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(options.today || ""))
    ? String(options.today)
    : new Date().toISOString().slice(0, 10);
  return [
    "请分析下面的个人工作留痕材料。只返回一个 JSON 对象，不要使用 Markdown。",
    categories.length ? `category 必须是以下之一或空字符串：${categories.join("、")}` : "category 必须返回空字符串。",
    projects.length
      ? `projectName 优先从已有项目或别名中选择；无法确定就返回空字符串。已有项目：${projects.join("；")}`
      : "projectName 仅在材料明确出现项目、客户或产品名称时填写，否则返回空字符串。",
    "JSON 字段：category、title、summary、tags、taskItems、riskNotes、projectName、projectConfidence、eventDate、eventType、participants、owners、decisions。",
    "eventDate 使用 YYYY-MM-DD，无法确定就留空；projectConfidence 是0到1之间的数字。",
    `今天是 ${today}。taskItems 是对象数组，每项字段为 text、dueDate、owner。dueDate 使用 YYYY-MM-DD；材料明确写出日期、今天/明天、周几或几天内时才换算填写，否则必须留空。owner 也只能在材料明确指定责任人时填写。`,
    "只有材料明确写出某人负责某事时才能放入 owners；仅仅提到某个人不代表他是责任人。",
    "title 不超过30个汉字；summary 不超过100个汉字；tags、riskNotes、participants、owners、decisions 都是字符串数组；taskItems 最多12项。",
    "不要补充材料中不存在的事实。",
    `原文件名：${filename}`,
    "材料文字：",
    text,
  ].join("\n");
}

function buildProjectOverviewPrompt(project, records) {
  const materials = records.map((record) => ({
    date: record.eventDate || String(record.createdAt || "").slice(0, 10),
    title: record.title || record.originalName,
    summary: record.summary || "",
    tasks: record.tasks || [],
    decisions: record.decisions || [],
    owners: record.owners || [],
  }));
  return [
    "请根据下面的项目记录生成项目进展概览。只返回一个 JSON 对象，不要使用 Markdown。",
    "JSON 字段：currentStage、progressSummary、completedHighlights、nextSteps、risks。",
    "currentStage 不超过20个汉字；progressSummary 不超过180个汉字；其余字段都是字符串数组，每项不超过80个汉字。",
    "必须区分已经发生的事实和待办，不要把待办写成已经完成；信息不足时明确写‘待确认’。",
    `项目名称：${project.name}`,
    `项目负责人：${project.owner || "未设置"}`,
    `项目记录：${JSON.stringify(materials)}`,
  ].join("\n");
}

function parseModelJson(raw = "", allowedCategories = CATEGORIES) {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error("AI 没有返回可识别的 JSON");
  }

  const value = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  const stringArray = (input, limit = 8) => Array.isArray(input) ? input.map(String).filter(Boolean).slice(0, limit) : [];
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(String(value.eventDate || "")) ? String(value.eventDate) : "";
  const rawTaskItems = Array.isArray(value.taskItems) && value.taskItems.length
    ? value.taskItems
    : (Array.isArray(value.tasks) ? value.tasks : []);
  const taskItems = rawTaskItems.flatMap((item) => {
    const text = String(typeof item === "string" ? item : item?.text || "").trim().slice(0, 300);
    if (!text) return [];
    const dueDate = String(typeof item === "object" ? item?.dueDate || "" : "");
    return [{
      text,
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : "",
      owner: String(typeof item === "object" ? item?.owner || "" : "").trim().slice(0, 60),
    }];
  }).slice(0, 12);
  const confidence = Number(value.projectConfidence);
  return {
    category: allowedCategories.includes(value.category) ? value.category : "",
    title: String(value.title || "未命名记录").slice(0, 60),
    summary: String(value.summary || "").slice(0, 240),
    tags: stringArray(value.tags),
    tasks: taskItems.map((item) => item.text),
    taskItems,
    riskNotes: stringArray(value.riskNotes),
    participants: stringArray(value.participants),
    owners: stringArray(value.owners),
    decisions: stringArray(value.decisions),
    eventDate,
    eventType: String(value.eventType || "").slice(0, 40),
    projectName: String(value.projectName || "").trim().slice(0, 80),
    projectConfidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
  };
}

function parseProjectOverviewJson(raw = "") {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error("AI 没有返回可识别的项目概览");
  const value = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  const stringArray = (input, limit = 8) => Array.isArray(input)
    ? input.map((item) => String(item).trim().slice(0, 120)).filter(Boolean).slice(0, limit)
    : [];
  return {
    currentStage: String(value.currentStage || "待确认").trim().slice(0, 40),
    progressSummary: String(value.progressSummary || "暂无足够信息").trim().slice(0, 360),
    completedHighlights: stringArray(value.completedHighlights),
    nextSteps: stringArray(value.nextSteps),
    risks: stringArray(value.risks),
  };
}

function createId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

module.exports = {
  CATEGORIES,
  DEFAULT_CATEGORIES,
  buildAnalysisPrompt,
  buildProjectOverviewPrompt,
  classifyLocal,
  createId,
  detectSensitiveRisks,
  parseModelJson,
  parseProjectOverviewJson,
  redactSensitive,
  sanitizeFilename,
};
