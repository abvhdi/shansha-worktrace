const state = {
  settings: null,
  records: [],
  manualTasks: [],
  filter: "全部",
  fileQuery: "",
  taskQuery: "",
  recordDateFilter: "",
  view: "today",
  timelineMode: "chronological",
  projectFilter: "__all__",
  projectPage: "timeline",
  projectContentView: "tasks",
  projectOverviews: {},
  overviewBusy: "",
  taskStatus: "open",
  aiTestPassed: false,
  pendingDeleteRecordId: "",
  pendingImports: 0,
  expandedRecords: new Set(),
  recentIds: new Set(),
  batchMode: false,
  batchSelection: new Set(),
  projectPickerTarget: null,
  editingTitleId: "",
  renamingProjectId: "",
  expandedTaskKeys: new Set(),
  taskLinkTarget: null,
  taskLinkRecordIds: new Set(),
  recordTaskTargetId: "",
  recordTaskSelection: new Set(),
  projectTaskPickerProjectId: "",
  projectTaskSelection: new Set(),
  projectManagerDraft: null,
  taskProjectCreateSelection: new Set(),
  assistantHistory: [],
  assistantBusy: false,
  assistantRecordIds: new Set(),
  assistantProjectIds: new Set(),
};

let refreshPromise = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function toast(message, isError = false) {
  const element = $("#toast");
  const openDialogs = $$('dialog[open]');
  const activeDialog = openDialogs[openDialogs.length - 1] || null;
  // A native <dialog> lives in the browser's top layer. A fixed toast left
  // under <body> will always be dimmed by its backdrop, regardless of z-index.
  // Move the same toast into the active dialog so the message stays crisp.
  (activeDialog || document.body).append(element);
  element.classList.toggle("dialog-toast", Boolean(activeDialog));
  element.textContent = message;
  element.style.background = isError ? "#8a3e34" : "#282b26";
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), isError ? 8000 : 3600);
  if (isError) {
    const notice = $("#noticeStack");
    if (activeDialog) {
      notice.innerHTML = "";
      notice.classList.add("hidden");
    } else {
      notice.innerHTML = `<div class="notice-error"><span><strong>操作没有完成</strong>${escapeHtml(message)}</span><button type="button" data-dismiss-notice aria-label="关闭提示">×</button></div>`;
      notice.classList.remove("hidden");
    }
  }
}

function assistantReady() {
  const provider = state.settings?.provider;
  const providerRequiresKey = provider !== "ollama";
  return Boolean(state.settings?.aiEnabled && state.settings?.aiVerified && (!providerRequiresKey || state.settings?.hasApiKey));
}

/** AI 没开启时，隐藏「工作助手」入口；已经打开的面板也一并收起。 */
function refreshAssistantEntry() {
  const button = $("#openAssistant");
  if (!button) return;
  const ready = assistantReady();
  button.classList.toggle("hidden", !ready);
  button.style.display = ready ? "" : "none";
  button.setAttribute("aria-hidden", ready ? "false" : "true");
  if (!ready && assistantOpen()) hideAssistant();
}

function assistantOpen() {
  return !$("#assistantPanel")?.classList.contains("hidden");
}

function toggleAssistantRecord(recordId) {
  if (!recordId) return;
  if (state.assistantRecordIds.has(recordId)) state.assistantRecordIds.delete(recordId);
  else {
    if (state.assistantRecordIds.size >= 12) {
      toast("一次最多选择 12 份文件", true);
      return;
    }
    state.assistantRecordIds.add(recordId);
  }
  renderAssistant();
  render();
}

function toggleAssistantProject(projectId) {
  if (!projectId || projectId === "__unassigned__") return;
  if (state.assistantProjectIds.has(projectId)) state.assistantProjectIds.delete(projectId);
  else {
    if (state.assistantProjectIds.size >= 6) {
      toast("一次最多选择 6 个项目", true);
      return;
    }
    state.assistantProjectIds.add(projectId);
  }
  renderAssistant();
  render();
}

/** 取标题最短（最贴近）的一条。 */
function shortestByTitle(list) {
  return list.slice().sort((a, b) => String(a.title || "").length - String(b.title || "").length)[0];
}

/**
 * 判断「名字」指向什么：先看句子线索，再看精确一致（项目 → 任务 → 资料），
 * 最后才用包含匹配（资料 → 项目 → 任务）。
 */
function resolveMention(name, contextText) {
  const wanted = String(name || "").trim();
  if (!wanted) return null;
  const ctx = String(contextText || "");
  const looksLikeFile = /文件|资料|文档|表格|图片|视频|截图|录屏|附件|素材|正文|稿子|稿件/.test(ctx);
  const looksLikeProject = /项目|进度|负责人|里程碑|看板|推进|归属|分组/.test(ctx);
  const stem = (value) => String(value || "").replace(/\.[^.]+$/, "");
  const records = Array.isArray(state.records) ? state.records : [];
  const projects = (state.settings && Array.isArray(state.settings.projects)) ? state.settings.projects : [];
  const tasks = Array.isArray(state.manualTasks) ? state.manualTasks : [];
  const exactRecord = records.find((item) => String(item.title || "") === wanted || stem(item.originalName) === wanted || String(item.originalName || "") === wanted);
  const exactProject = projects.find((item) => String(item.name || "") === wanted || (Array.isArray(item.aliases) && item.aliases.indexOf(wanted) >= 0));
  const exactTask = tasks.find((item) => String(item.text || "").trim() === wanted);
  const looseRecord = records.filter((item) => String(item.title || "").indexOf(wanted) >= 0 || stem(item.originalName).indexOf(wanted) >= 0);
  const looseProject = projects.find((item) => String(item.name || "").indexOf(wanted) >= 0);
  const looseTask = tasks.find((item) => String(item.text || "").indexOf(wanted) >= 0);
  // 1) 句子线索优先
  if (looksLikeFile && !looksLikeProject) {
    if (exactRecord) return { kind: "record", id: exactRecord.id };
    if (looseRecord.length) return { kind: "record", id: shortestByTitle(looseRecord).id };
    if (exactTask) return { kind: "task", id: exactTask.id };
  }
  if (looksLikeProject && !looksLikeFile) {
    if (exactProject) return { kind: "project", id: exactProject.id };
    if (looseProject) return { kind: "project", id: looseProject.id };
    if (exactTask) return { kind: "task", id: exactTask.id };
  }
  // 2) 完全一致：项目 → 任务 → 资料
  if (exactProject) return { kind: "project", id: exactProject.id };
  if (exactTask) return { kind: "task", id: exactTask.id };
  if (exactRecord) return { kind: "record", id: exactRecord.id };
  // 3) 包含匹配：资料 → 项目 → 任务
  if (looseRecord.length) return { kind: "record", id: shortestByTitle(looseRecord).id };
  if (looseProject) return { kind: "project", id: looseProject.id };
  if (looseTask) return { kind: "task", id: looseTask.id };
  return null;
}

/** 把回答里的「名字」变成可点击胶囊：资料跳记录、项目跳项目、任务跳任务。 */
function linkMentions(html) {
  const hints = { record: "点击跳到这条资料", project: "点击跳到这个项目", task: "点击跳到这条任务" };
  const source = String(html || "");
  return source.replace(/「([^」]{1,60})」/g, (whole, name, offset) => {
    const context = source.slice(Math.max(0, offset - 14), offset) + source.slice(offset + whole.length, offset + whole.length + 10);
    const hit = resolveMention(name, context);
    if (!hit) return whole;
    return `<button type="button" class="assistant-cite inline-cite" data-assistant-jump="${hit.kind}" data-assistant-target="${escapeHtml(hit.id)}" title="${hints[hit.kind]}">${whole}</button>`;
  });
}

function assistantActionLabel(type) {
  return {
    create_task: "新建任务",
    update_task: "修改任务",
    create_project: "新建项目",
    update_record: "修改文件信息",
    create_office_file: "生成 Office 成果",
  }[type] || "待执行操作";
}

function assistantActionPreview(action) {
  if (action?.type !== "create_office_file") return "";
  const input = action.input || {};
  let preview = "";
  if (input.type === "xlsx") {
    preview = (input.sheets || []).slice(0, 4).map((sheet) => {
      const rows = (sheet.rows || []).slice(0, 8).map((row) => row.slice(0, 8).join("\t")).join("\n");
      return `【${sheet.name || "工作表"}】\n${rows}`;
    }).join("\n\n");
  } else {
    preview = String(input.content || "");
  }
  if (!preview) return "";
  const clipped = preview.length > 1800 ? `${preview.slice(0, 1800)}\n……` : preview;
  return `<details class="assistant-action-preview"><summary>查看将写入的内容</summary><pre>${escapeHtml(clipped)}</pre></details>`;
}

function renderAssistantActions(actions, messageIndex) {
  if (!Array.isArray(actions) || !actions.length) return "";
  return `<div class="assistant-actions">${actions.map((action) => {
    const status = ["pending", "executing", "done", "error", "cancelled"].includes(action.status) ? action.status : "pending";
    const statusText = {
      pending: "等待确认",
      executing: "正在执行…",
      done: "已执行",
      error: "执行失败",
      cancelled: "已取消",
    }[status];
    const buttons = status === "pending"
      ? `<div class="assistant-action-buttons"><button type="button" class="primary" data-assistant-execute="${messageIndex}" data-assistant-action="${escapeHtml(action.id)}">确认执行</button><button type="button" class="secondary" data-assistant-cancel="${messageIndex}" data-assistant-action="${escapeHtml(action.id)}">取消</button></div>`
      : "";
    const error = status === "error" && action.error ? `<p class="assistant-action-error">${escapeHtml(action.error)}</p>` : "";
    return `<section class="assistant-action ${status}">
      <div class="assistant-action-head"><strong>${escapeHtml(assistantActionLabel(action.type))}</strong><span>${statusText}</span></div>
      <p>${escapeHtml(action.summary || "已准备一项操作")}</p>${assistantActionPreview(action)}${error}${buttons}
    </section>`;
  }).join("")}</div>`;
}

function renderAssistant() {
  const log = $("#assistantLog");
  const suggestions = $("#assistantSuggest");
  const context = $("#assistantContext");
  if (!log || !suggestions || !context) return;
  const projectChips = [...state.assistantProjectIds].map((id) => {
    const project = state.settings?.projects?.find((item) => item.id === id);
    return project ? `<button type="button" data-remove-assistant-project="${escapeHtml(id)}"><span>项目</span>${escapeHtml(project.name)} ×</button>` : "";
  }).filter(Boolean);
  const recordChips = [...state.assistantRecordIds].map((id) => {
    const record = state.records.find((item) => item.id === id);
    return record ? `<button type="button" data-remove-assistant-record="${escapeHtml(id)}"><span>文件</span>${escapeHtml(record.title || record.originalName)} ×</button>` : "";
  }).filter(Boolean);
  context.innerHTML = projectChips.length || recordChips.length
    ? `<div class="assistant-context-head"><strong>本次对话读取</strong><button type="button" data-clear-assistant-context>清空</button></div><div class="assistant-context-chips">${[...projectChips, ...recordChips].join("")}</div>`
    : `<p>打开聊天后，可在主界面点击项目或文件，多选后一起提问。</p>`;
  log.innerHTML = state.assistantHistory.length
    ? state.assistantHistory.map((item, messageIndex) => {
      const citations = Array.isArray(item.citations) && item.citations.length
        ? `<div class="assistant-cites">${item.citations.map((cite) => `<button type="button" class="assistant-cite" data-assistant-cite="${escapeHtml(cite.id)}">打开：${escapeHtml(cite.title || cite.originalName || "资料")}</button>`).join("")}</div>`
        : "";
      const actions = item.role === "assistant" ? renderAssistantActions(item.actions, messageIndex) : "";
      const bodyHtml = item.role === "assistant" && !item.error ? linkMentions(escapeHtml(item.content)) : escapeHtml(item.content);
    return `<div class="assistant-msg ${item.role === "user" ? "user" : item.error ? "error" : "assistant"}">${bodyHtml}${citations}${actions}</div>`;
    }).join("")
    : `<div class="assistant-msg assistant">我可以读取 Word、Excel 和 PPT，也能把整理结果生成新文件、保存到资料库并关联回任务。写入前会先给你预览和确认。</div>`;
  suggestions.innerHTML = state.assistantBusy ? "" : [
    "最近有什么新资料？",
    "帮我整理本周进展",
    "根据所选资料生成 Word 总结",
    "把所选表格整理成新 Excel",
  ].map((text) => `<button type="button" data-assistant-suggestion="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("");
  log.scrollTop = log.scrollHeight;
  $("#assistantSend").disabled = state.assistantBusy;
  $("#assistantText").disabled = state.assistantBusy;
}

function showAssistant() {
  const panel = $("#assistantPanel");
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.setAttribute("aria-hidden", "false");
  renderAssistant();
  render();
  setTimeout(() => $("#assistantText")?.focus(), 0);
}

function hideAssistant() {
  const panel = $("#assistantPanel");
  if (!panel) return;
  panel.classList.add("hidden");
  panel.setAttribute("aria-hidden", "true");
  render();
}

let agentTurn = null;
let agentEventsBound = false;

function bindAgentEvents() {
  if (agentEventsBound || typeof window.worktrace?.onAgentEvent !== "function") return;
  agentEventsBound = true;
  window.worktrace.onAgentEvent((payload) => {
    if (!agentTurn || !payload) return;
    if (payload.kind === "assistant" || payload.kind === "tool") {
      agentTurn.entry.content = payload.text || agentTurn.entry.content;
      renderAssistant();
    } else if (payload.kind === "error") {
      agentTurn.entry.error = true;
      agentTurn.entry.content = payload.text || "执行出错";
      renderAssistant();
    } else if (payload.kind === "turnEnd") {
      const done = agentTurn.done;
      agentTurn = null;
      done();
      refresh().then(() => { renderAssistant(); if (payload.mutated) toast("资料已经更新，界面已同步"); }).catch(() => {});
    }
  });
}

function askAgent(question) {
  bindAgentEvents();
  return new Promise((resolve) => {
    const entry = { role: "assistant", content: "思考中…" };
    state.assistantHistory.push(entry);
    renderAssistant();
    const timer = setTimeout(() => {
      if (agentTurn && agentTurn.entry === entry) {
        agentTurn = null;
        if (entry.content === "思考中…") { entry.content = "（超时：智能体没有在预期时间内回应）"; entry.error = true; }
        renderAssistant();
        resolve();
      }
    }, 300000);
    agentTurn = { entry, done: () => { clearTimeout(timer); resolve(); } };
    window.worktrace.agentSend(question).catch((error) => {
      clearTimeout(timer);
      agentTurn = null;
      entry.error = true;
      entry.content = "智能体启动失败：" + String((error && error.message) || error);
      renderAssistant();
      resolve();
    });
  });
}

async function askAssistant(text) {
  const question = String(text || "").trim();
  if (!question || state.assistantBusy) return;
  // 写入操作必须经过本界面的确认卡片，不让外部 agent 绕过确认直接修改数据。
  const useAgent = false;
  if (!useAgent && !assistantReady()) {
    toast("请先在设置中保存有效的 AI 配置", true);
    hideAssistant();
    populateSettings();
    $("#settingsDialog").showModal();
    return;
  }
  state.assistantHistory.push({ role: "user", content: question });
  state.assistantBusy = true;
  renderAssistant();
  try {
    if (useAgent) {
      await askAgent(question);
    } else {
      const result = await window.worktrace.chat(
        state.assistantHistory.map(({ role, content }) => ({ role, content })),
        { recordIds: [...state.assistantRecordIds], projectIds: [...state.assistantProjectIds] },
      );
      state.assistantHistory.push({
        role: "assistant",
        content: result.reply || "没有返回内容。",
        citations: result.citations || [],
        actions: result.actions || [],
      });
    }
  } catch (error) {
    state.assistantHistory.push({ role: "assistant", content: error.message || "工作助手暂时无法回答。", error: true });
  } finally {
    state.assistantBusy = false;
    renderAssistant();
  }
}

function setTestResult(message, stateName = "neutral") {
  const element = $("#testResult");
  if (!element) return;
  element.textContent = message;
  element.dataset.state = stateName;
}

function dayKey(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return String(value);
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recordDay(record) {
  return dayKey(record.eventDate || record.createdAt);
}

function projectsByRecentActivity() {
  const latest = new Map();
  const remember = (projectId, value) => {
    if (!projectId || !value) return;
    const key = String(value);
    if (!latest.has(projectId) || key > latest.get(projectId)) latest.set(projectId, key);
  };
  state.records.forEach((record) => remember(record.projectId, record.eventDate || record.createdAt));
  state.manualTasks.forEach((task) => remember(task.projectId, task.updatedAt || task.createdAt));
  return state.settings.projects
    .map((project, index) => ({ project, index, recent: latest.get(project.id) || "" }))
    .sort((a, b) => {
      if (a.recent !== b.recent) return b.recent.localeCompare(a.recent);
      return a.index - b.index;
    })
    .map((item) => item.project);
}

// ---------- 项目选项（一层，扁平） ----------
function projectOptionsMarkup(selectedId) {
  return projectsByRecentActivity().map((project) =>
    `<option value="${escapeHtml(project.id)}"${selected(selectedId, project.id)}>${escapeHtml(project.name)}</option>`,
  ).join("");
}

function normalizeSearch(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function recordSearchText(record) {
  return normalizeSearch([
    record.title,
    record.originalName,
    record.summary,
    record.ocrText,
    record.category,
    ...(record.tags || []),
    ...(record.owners || []),
    ...(record.tasks || []),
    ...taskItemsFor(record).map((task) => task.text),
  ].join(" "));
}

function taskSearchText(task) {
  const project = state.settings?.projects?.find((item) => item.id === task.projectId);
  return normalizeSearch([
    task.text,
    task.owner,
    task.sourceLabel,
    task.dueDate,
    project?.name,
    ...linkedRecords(task).flatMap((record) => [record.title, record.originalName, record.summary, ...(record.tags || [])]),
  ].join(" "));
}

function formatDate(record) {
  const value = record.eventDate || record.createdAt;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(year, month - 1, day));
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function dateGroupLabel(key) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const today = dayKey(new Date().toISOString());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const prefix = key === today ? "今天" : key === dayKey(yesterdayDate.toISOString()) ? "昨天" : "";
  const label = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(date);
  return prefix ? `${prefix} · ${label}` : `${year}年${label}`;
}

function iconFor(record) {
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"].includes(record.extension)) return "▧";
  if (record.extension === ".pdf") return "PDF";
  if ([".doc", ".docx"].includes(record.extension)) return "W";
  if ([".xls", ".xlsx"].includes(record.extension)) return "X";
  if ([".ppt", ".pptx"].includes(record.extension)) return "P";
  return "≡";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function highlightedSnippet(record, queryInput) {
  const query = normalizeSearch(queryInput);
  if (!query) return "";
  const sources = [record.title, record.originalName, record.summary, record.ocrText, ...(record.tags || []), ...(record.tasks || [])];
  const source = sources.map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .find((value) => normalizeSearch(value).includes(query));
  if (!source) return "";
  const lower = normalizeSearch(source);
  const index = lower.indexOf(query);
  const start = Math.max(0, index - 48);
  const end = Math.min(source.length, index + query.length + 72);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < source.length ? "…" : "";
  const before = source.slice(start, index);
  const match = source.slice(index, index + query.length);
  const after = source.slice(index + query.length, end);
  return `${prefix}${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}${suffix}`;
}

function indexedTimeLabel(record) {
  if (!record.contentIndexedAt) return "等待首次内容索引";
  const date = new Date(record.contentIndexedAt);
  if (Number.isNaN(date.getTime())) return "内容已索引";
  return `最后识别：${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

function selected(value, expected) {
  return String(value || "") === String(expected || "") ? " selected" : "";
}

function categoryIdFor(record) {
  if (record.categoryId) return record.categoryId;
  return state.settings.categories.find((item) => item.name === record.category)?.id || "";
}

function taskItemsFor(record) {
  if (Array.isArray(record.taskItems) && record.taskItems.length) return record.taskItems;
  return (record.tasks || []).map((text, index) => ({
    id: `${record.id}-task-${index + 1}`,
    text,
    completed: false,
    projectId: "",
    owner: "",
    dueDate: "",
  }));
}

function aiTextInputReady() {
  const provider = state.settings?.providers?.[state.settings?.provider];
  return Boolean(state.settings?.aiEnabled && state.settings?.aiVerified && provider && (!provider.requiresKey || state.settings.hasApiKey));
}

function renderProjectControl(record) {
  const project = state.settings.projects.find((item) => item.id === record.projectId);
  const suggestion = aiTextInputReady() && !record.projectId && record.suggestedProjectName
    ? `<span class="project-suggestion">AI建议：${escapeHtml(record.suggestedProjectName)}${record.suggestedProjectId ? `<button data-confirm-project="${escapeHtml(record.id)}" data-project-id="${escapeHtml(record.suggestedProjectId)}">确认</button>` : "（可在设置中添加）"}</span>`
    : "";
  const autoAssigned = record.projectId && record.projectAssignmentSource && record.projectAssignmentSource !== "manual"
    ? `<span class="project-suggestion auto-assigned">已自动归入，如果不对可直接改</span>`
    : "";
  return `
    <button type="button" class="selector-trigger" data-select-record-project="${escapeHtml(record.id)}"><span>所属项目</span><strong>${escapeHtml(project?.name || "跨项目 / 全局资料")}</strong><b>更换</b></button>
    ${suggestion}${autoAssigned}`;
}

function renderCategoryControl(record) {
  if (!state.settings.categoriesEnabled) return "";
  const currentId = categoryIdFor(record);
  const options = state.settings.categories.map((category) =>
    `<option value="${escapeHtml(category.id)}"${selected(currentId, category.id)}>${escapeHtml(category.name)}</option>`,
  ).join("");
  return `<select data-category-select="${escapeHtml(record.id)}" title="调整文件夹标签">${options}</select>`;
}

function renderRecord(record) {
  const expanded = state.expandedRecords.has(record.id);
  const justAdded = state.recentIds.has(record.id);
  const selectedForAssistant = state.assistantRecordIds.has(record.id);
  const project = state.settings.projects.find((item) => item.id === record.projectId);
  const tags = (record.tags || []).slice(0, 4);
  const linkedTasks = tasksLinkedToRecord(record.id);
  const searchSnippet = state.view === "today" ? highlightedSnippet(record, state.fileQuery) : "";
  const facts = [
    record.owners?.length ? `责任人：${record.owners.join("、")}` : "",
    linkedTasks.length ? `关联任务：${linkedTasks.slice(0, 2).map((task) => task.text).join("；")}` : "",
    record.decisions?.length ? `决定：${record.decisions.slice(0, 1).join("；")}` : "",
  ].filter(Boolean);
  return `
    <article class="record${expanded ? " expanded" : ""}${justAdded ? " just-added" : ""}${selectedForAssistant ? " assistant-selected" : ""}" data-record-id="${escapeHtml(record.id)}">
      ${state.batchMode ? `<label class="record-check" title="选择这条记录"><input type="checkbox" data-record-check="${escapeHtml(record.id)}" ${state.batchSelection.has(record.id) ? "checked" : ""} /></label>` : ""}
      <div class="record-icon">${iconFor(record)}</div>
      <div class="record-main">
        <div class="record-title">
          ${state.editingTitleId === record.id
            ? `<input class="title-input" data-title-input="${escapeHtml(record.id)}" value="${escapeHtml(record.title)}" maxlength="120" />`
            : `<strong class="record-title-text" data-edit-title="${escapeHtml(record.id)}" title="点击修改标题">${escapeHtml(record.title)}</strong>`}
          ${state.settings.categoriesEnabled && record.category ? `<span class="category">${escapeHtml(record.category)}</span>` : ""}
          ${record.eventType ? `<span class="category">${escapeHtml(record.eventType)}</span>` : ""}
          ${justAdded ? `<span class="badge-new">刚刚加入</span>` : ""}
          ${selectedForAssistant ? `<span class="badge-context">已选入对话</span>` : ""}
        </div>
        <div class="record-summary">${escapeHtml(record.summary || record.originalName)}</div>
        ${searchSnippet ? `<div class="search-match"><span>命中内容</span><p>${searchSnippet}</p></div>` : ""}
        <div class="record-tags">
          ${project ? `<button class="chip chip-project" data-pick-project="${escapeHtml(record.id)}" title="点击更换项目">${escapeHtml(project.name)}</button>` : `<button class="chip chip-muted" data-pick-project="${escapeHtml(record.id)}" title="点击归入项目">跨项目资料</button>`}
          ${tags.map((tag) => `<span class="chip">#${escapeHtml(tag)}</span>`).join("")}
        </div>
        ${facts.length ? `<div class="record-facts">${escapeHtml(facts.join(" · "))}</div>` : ""}
        ${expanded ? `<div class="record-primary-actions">
          <button class="secondary compact record-reveal" data-reveal="${escapeHtml(record.storedPath)}">查看文件位置</button>
          <button type="button" class="secondary compact" data-link-record-tasks="${escapeHtml(record.id)}">关联任务</button>
          <button type="button" class="primary compact" data-create-record-task="${escapeHtml(record.id)}">＋ 新建任务</button>
        </div>` : ""}
        ${expanded ? renderRecordTaskPanel(record, linkedTasks) : ""}
        ${expanded ? `<div class="record-inline-settings">
          <span class="record-settings-caption">文件信息</span>
          <div class="record-setting-project">${renderProjectControl(record)}</div>
          ${state.settings.categoriesEnabled ? `<label><span>标签</span>${renderCategoryControl(record)}</label>` : ""}
          <label><span>记录日期</span><input type="date" data-event-date="${escapeHtml(record.id)}" value="${escapeHtml(recordDay(record))}" title="事情实际发生的日期" /></label>
          <button class="record-refresh-link" data-refresh-record="${escapeHtml(record.id)}">重新读取</button>
          <span class="index-status">${escapeHtml(indexedTimeLabel(record))}</span>
        </div>` : ""}
        ${record.extractionError ? `<div class="risk">正文读取提示：${escapeHtml(record.extractionError)}；原文件已正常保存</div>` : ""}
        ${record.riskNotes?.length ? `<div class="risk">△ 上传提醒：${escapeHtml(record.riskNotes.join(" · "))}</div>` : ""}
        ${record.aiStatus === "failed" ? `<div class="risk">AI 整理失败，已保留本地结果：${escapeHtml(record.aiError)}</div>` : ""}
      </div>
      <div class="record-meta">${formatDate(record)}<button class="record-open" data-open-file="${escapeHtml(record.storedPath)}">打开文件</button><button class="record-delete" data-delete-record="${escapeHtml(record.id)}">删除记录</button></div>
    </article>`;
}

function renderFilters() {
  if (!state.settings.categoriesEnabled || state.settings.categories.length === 0) {
    $("#filters").innerHTML = "";
    state.filter = "全部";
    return;
  }
  const validNames = new Set(state.settings.categories.map((item) => item.name));
  if (state.filter !== "全部" && !validNames.has(state.filter)) state.filter = "全部";
  $("#filters").innerHTML = [
    `<button class="${state.filter === "全部" ? "active" : ""}" data-filter="全部">全部</button>`,
    ...state.settings.categories.map((item) => `<button class="${state.filter === item.name ? "active" : ""}" data-filter="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>`),
  ].join("");
}

function renderProjectFilter() {
  const projects = projectsByRecentActivity();
  if (state.projectFilter && !["__all__", "__unassigned__"].includes(state.projectFilter) && !projects.some((item) => item.id === state.projectFilter)) {
    state.projectFilter = "__all__";
  }
  const current = projects.find((project) => project.id === state.projectFilter);
  $("#projectFilterName").textContent = state.projectFilter === "__unassigned__"
    ? "跨项目 / 全局资料"
    : current?.name || "全部项目";
}

function renderProjectOverview(records) {
  const element = $("#projectOverview");
  if (state.view !== "timeline" || state.timelineMode !== "project" || state.projectPage !== "overview" || state.projectFilter === "__unassigned__") {
    element.classList.add("hidden");
    return;
  }
  const project = state.settings.projects.find((item) => item.id === state.projectFilter);
  if (!project) {
    element.classList.add("hidden");
    return;
  }
  const owners = [...new Set([project.owner, ...records.flatMap((record) => record.owners || [])].filter(Boolean))];
  const taskItems = tasksForProject(project.id);
  const remainingTasks = taskItems.filter((item) => !item.completed).length;
  const completedTasks = taskItems.length - remainingTasks;
  const progress = taskItems.length ? Math.round((completedTasks / taskItems.length) * 100) : 0;
  const latest = records[0];
  element.innerHTML = `
    <div><h3><button class="project-context-title" data-project-context="${escapeHtml(project.id)}">${escapeHtml(project.name)}</button></h3><p>${latest ? `最近进展：${escapeHtml(latest.summary || latest.title)}` : "还没有项目记录"}</p><div class="project-progress-track"><span style="width:${progress}%"></span></div></div>
    <div class="project-stat"><strong>${records.length}</strong><span>项目记录</span></div>
    <div class="project-stat"><strong>${taskItems.length ? `${progress}%` : "待确认"}</strong><span>${completedTasks}/${taskItems.length} 项待办已完成</span></div>
    <div class="project-stat"><strong>${escapeHtml(owners.join("、") || "待确认")}</strong><span>责任人</span></div>`;
  element.classList.remove("hidden");
}

function renderProjectGroups(records) {
  const limitToVisibleRecords = Boolean(state.recordDateFilter || state.projectFilter !== "__all__");
  const projectGroups = projectsByRecentActivity().map((project) => ({
    id: project.id,
    name: project.name,
    owner: project.owner || "",
    records: records.filter((record) => record.projectId === project.id),
    taskCount: tasksForProject(project.id).length,
  })).filter((group) => !limitToVisibleRecords || group.records.length > 0);
  const unassigned = records.filter((record) => !record.projectId);
  const groups = [
    ...projectGroups,
    ...(unassigned.length ? [{ id: "__unassigned__", name: "跨项目 / 全局资料", owner: "不属于单一项目", records: unassigned, taskCount: unassignedTasks().length }] : []),
  ];
  return groups.map((group) => `
    <section class="project-record-group">
      <header class="project-record-head">
        <div>
          <span>${group.id === "__unassigned__" ? "OTHER" : "PROJECT"}</span>
          ${state.renamingProjectId === group.id
            ? `<input class="title-input" data-rename-input="${escapeHtml(group.id)}" value="${escapeHtml(group.name)}" maxlength="80" />`
            : group.id === "__unassigned__" ? `<h3>${escapeHtml(group.name)}</h3>` : `<h3><button class="project-context-title" data-project-context="${escapeHtml(group.id)}">${escapeHtml(group.name)}</button></h3>`}
          <p>${escapeHtml(group.owner || "未设置负责人")} · ${group.records.length} 份文件 · ${group.taskCount || 0} 个任务</p>
        </div>
        ${group.id === "__unassigned__" ? "" : `<div class="project-record-actions">
          <button class="secondary compact" data-open-project="${escapeHtml(group.id)}">查看项目概览</button>
          <button class="secondary compact" data-rename-project="${escapeHtml(group.id)}">改名</button>
          <button class="secondary compact" data-delete-project="${escapeHtml(group.id)}">删除</button>
        </div>`}
      </header>
      <div class="project-record-items">${group.records.length ? group.records.map(renderRecord).join("") : `<div class="task-empty">这个项目还没有文件，可以先进入项目添加任务。</div>`}</div>
    </section>`).join("");
}

function renderOverviewList(title, items, emptyText) {
  return `
    <div class="overview-list">
      <h4>${title}</h4>
      ${items?.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>${emptyText}</p>`}
    </div>`;
}

function renderTaskRow(task) {
  const sourceKind = task.kind || task.sourceKind || "manual";
  const recordId = task.record?.id || task.recordId || "";
  const normalized = { ...task, sourceKind, recordId, recordIds: linkedRecordIds({ ...task, sourceKind, recordId }) };
  const key = taskKey(normalized);
  const expanded = state.expandedTaskKeys.has(key);
  const count = linkedRecords(normalized).length;
  const edit = sourceKind === "manual"
    ? `<input data-manual-task-text data-task-id="${escapeHtml(task.id)}" value="${escapeHtml(task.text)}" maxlength="300" aria-label="编辑待办" />`
    : `<input data-task-text data-record-id="${escapeHtml(recordId)}" data-task-id="${escapeHtml(task.id)}" value="${escapeHtml(task.text)}" maxlength="300" aria-label="编辑待办" />`;
  const toggle = sourceKind === "manual"
    ? `<input type="checkbox" data-manual-task-toggle data-task-id="${escapeHtml(task.id)}" ${task.completed ? "checked" : ""} aria-label="标记待办完成" />`
    : `<input type="checkbox" data-task-toggle data-record-id="${escapeHtml(recordId)}" data-task-id="${escapeHtml(task.id)}" ${task.completed ? "checked" : ""} aria-label="标记待办完成" />`;
  const detail = sourceKind === "manual"
    ? `${task.owner ? escapeHtml(task.owner) : "手工任务"}${task.dueDate ? ` · 截止 ${escapeHtml(task.dueDate)}` : ""}`
    : `来自资料：${escapeHtml(task.record?.title || task.record?.originalName || "")}`;
  const remove = sourceKind === "manual"
    ? `<button class="task-delete" data-manual-task-delete data-task-id="${escapeHtml(task.id)}">删除</button>`
    : `<button class="task-delete" data-task-delete data-record-id="${escapeHtml(recordId)}" data-task-id="${escapeHtml(task.id)}">删除</button>`;
  return `
    <div class="project-task-row${task.completed ? " completed" : ""}${expanded ? " links-open" : ""}" data-project-task-kind="${escapeHtml(sourceKind)}" data-project-task-id="${escapeHtml(task.id)}" data-project-record-id="${escapeHtml(recordId)}" data-project-task-key="${escapeHtml(key)}">
      ${toggle}
      <div class="task-edit-wrap">${edit}<span>${detail}</span><button type="button" class="task-file-link" data-toggle-project-task-files>${count} 个关联文件 ${expanded ? "▴" : "▾"}</button></div>
      <div class="project-task-actions"><button type="button" class="secondary compact" data-edit-project-task-files>关联文件</button>${remove}</div>
      ${expanded ? `<div class="project-task-linked">${renderLinkedFiles(normalized, true)}</div>` : ""}
    </div>`;
}

function renderProjectFileRow(record) {
  const tasks = tasksLinkedToRecord(record.id);
  return `<article class="project-file-row${state.assistantRecordIds.has(record.id) ? " assistant-selected" : ""}">
    <div class="project-file-head">
      <div class="record-icon">${iconFor(record)}</div>
      <div><h4>${escapeHtml(record.title || record.originalName)}</h4><p>${escapeHtml(record.summary || record.originalName || "")}</p></div>
      <button type="button" class="secondary compact" data-open-project-file="${escapeHtml(record.storedPath || "")}" data-project-file-id="${escapeHtml(record.id)}">${assistantOpen() ? (state.assistantRecordIds.has(record.id) ? "移出对话" : "加入对话") : "打开文件"}</button>
    </div>
    <div class="project-file-tasks">
      <div class="project-file-task-head"><strong>${tasks.length} 个关联任务</strong><div><button type="button" class="secondary compact" data-reveal-project-file="${escapeHtml(record.storedPath || "")}">查看文件位置</button><button type="button" class="secondary compact" data-link-record-tasks="${escapeHtml(record.id)}">关联任务</button><button type="button" class="primary compact" data-create-record-task="${escapeHtml(record.id)}">＋ 新建任务</button></div></div>
      ${tasks.length ? `<ul>${tasks.map((task) => `<li class="${task.completed ? "completed" : ""}"><span>${task.completed ? "✓" : "○"}</span>${escapeHtml(task.text)}</li>`).join("")}</ul>` : `<p>还没有从这份文件识别或关联任务。</p>`}
    </div>
  </article>`;
}

function renderProjectDetail(records) {
  const element = $("#projectDetail");
  const active = state.view === "timeline"
    && state.timelineMode === "project"
    && state.projectPage === "overview"
    && state.projectFilter !== "__unassigned__";
  const project = state.settings.projects.find((item) => item.id === state.projectFilter);
  if (!active || !project) {
    element.classList.add("hidden");
    return;
  }

  const overview = state.projectOverviews[project.id];
  const busy = state.overviewBusy === project.id;
  const aiReady = aiTextInputReady();
  const allTasks = tasksForProject(project.id).map((task) => ({ kind: task.sourceKind, ...task }));
  const completedCount = allTasks.filter((task) => task.completed).length;
  const latest = records[0];
  const localSummary = latest
    ? `项目目前有 ${records.length} 条记录，最近一条是“${latest.title || latest.originalName}”。点击 AI 生成后，会进一步判断项目所处阶段、已经完成的事项和下一步。`
    : "项目还没有记录，先把资料归入这个项目。";
  const updatedLabel = overview?.generatedAt
    ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(overview.generatedAt))
    : "";

  element.innerHTML = `
    ${aiReady ? `<div class="overview-card progress-card">
      <div class="overview-card-head">
        <div>
          <span class="stage-badge">${escapeHtml(overview?.currentStage || "待生成")}</span>
          <h3>项目进行到哪里</h3>
        </div>
        <button class="primary compact" data-generate-overview ${busy ? "disabled" : ""}>${busy ? "AI 正在整理…" : overview ? "重新生成概览" : "AI 生成概览"}</button>
      </div>
      <p class="progress-summary">${escapeHtml(overview?.progressSummary || localSummary)}</p>
      ${updatedLabel ? `<p class="overview-updated">${updatedLabel} 生成 · 使用 ${escapeHtml(overview.model || "已配置模型")}${overview.skippedCount ? ` · ${overview.skippedCount} 条敏感记录未发送` : ""}</p>` : `<p class="overview-updated">${state.settings.hasApiKey ? "密钥已保存；当前尚未启用 AI" : "尚未保存 AI 密钥"}</p>`}
      ${overview ? `<div class="overview-columns">
        ${renderOverviewList("已经完成", overview.completedHighlights, "暂未识别")}
        ${renderOverviewList("下一步", overview.nextSteps, "暂未识别")}
        ${renderOverviewList("风险与待确认", overview.risks, "暂未发现")}
      </div>` : ""}
    </div>` : ""}

    <div class="overview-card task-card project-content-card">
      <div class="overview-card-head">
        <div><h3>项目内容</h3><p>${records.length} 份文件 · ${allTasks.length} 个任务</p></div>
        <div class="task-card-actions">
          <div class="segmented project-content-switch">
            <button class="${state.projectContentView === "tasks" ? "active" : ""}" data-project-content="tasks">任务视角</button>
            <button class="${state.projectContentView === "files" ? "active" : ""}" data-project-content="files">文件视角</button>
          </div>
          ${state.projectContentView === "tasks"
            ? `<button class="secondary compact" data-add-existing-task>添加已有任务</button><button class="secondary compact" data-add-manual-task>＋ 新建任务</button>`
            : `<button class="secondary compact" data-add-project-files>选择文件</button><button class="secondary compact" data-new-project-file>＋ 新建文件</button>`}
        </div>
      </div>
      ${state.projectContentView === "tasks"
        ? `<div class="project-task-list">${allTasks.length ? allTasks.map(renderTaskRow).join("") : `<div class="task-empty">还没有任务。可以新建任务，也可以把未归项目的任务加进来。</div>`}</div>`
        : `<div class="project-file-list">${records.length ? records.map(renderProjectFileRow).join("") : `<div class="task-empty">这个项目还没有文件。</div>`}</div>`}
    </div>`;
  element.classList.remove("hidden");
}

async function loadProjectOverview(projectId) {
  if (!projectId || ["__all__", "__unassigned__"].includes(projectId) || Object.hasOwn(state.projectOverviews, projectId)) return;
  state.overviewBusy = projectId;
  render();
  try {
    state.projectOverviews[projectId] = await window.worktrace.getProjectOverview(projectId);
  } catch (error) {
    toast(error.message, true);
    state.projectOverviews[projectId] = null;
  } finally {
    state.overviewBusy = "";
    render();
  }
}

function taskProjectOptions(projectId = "") {
  return [
    `<option value=""${selected(projectId, "")}>无项目</option>`,
    projectOptionsMarkup(projectId),
  ].join("");
}

function taskKey(task) {
  return `${task.sourceKind || task.kind || "manual"}:${task.recordId || task.record?.id || ""}:${task.id}`;
}

function linkedRecordIds(task) {
  const sourceRecordId = task.sourceKind === "record" || task.kind === "record"
    ? (task.recordId || task.record?.id || "")
    : "";
  return [...new Set([sourceRecordId, ...(Array.isArray(task.recordIds) ? task.recordIds : [])].filter(Boolean))];
}

function linkedRecords(task) {
  const ids = new Set(linkedRecordIds(task));
  return state.records.filter((record) => ids.has(record.id));
}

function tasksLinkedToRecord(recordId) {
  return allTasksForPage()
    .filter((task) => linkedRecordIds(task).includes(recordId))
    .sort(compareTaskPriority);
}

function renderRecordTaskPanel(record, tasks = tasksLinkedToRecord(record.id)) {
  return `<section class="record-task-panel">
    <div class="record-task-head">
      <div><strong>关联任务</strong><span>${tasks.length ? `${tasks.length} 项，修改后会同步到任务列表和项目` : "尚未关联任务"}</span></div>
    </div>
    ${tasks.length ? `<ul>${tasks.map((task) => `<li class="${task.completed ? "completed" : ""}"><span>${task.completed ? "✓" : "○"}</span><span>${escapeHtml(task.text)}</span>${task.dueDate ? `<small>截止 ${escapeHtml(task.dueDate)}</small>` : ""}</li>`).join("")}</ul>` : `<p>可以关联任务列表中的任务，或直接为这份文件新建任务。</p>`}
  </section>`;
}

function renderLinkedFiles(task, compact = false) {
  const records = linkedRecords(task);
  if (!records.length) return `<div class="task-linked-empty">还没有关联文件，可以手动添加。</div>`;
  return `<div class="task-linked-files${compact ? " compact-list" : ""}">${records.map((record) => `
    <button type="button" data-open-linked-file="${escapeHtml(record.storedPath || "")}" data-linked-record-id="${escapeHtml(record.id)}">
      <span class="linked-file-icon">${iconFor(record)}</span>
      <span><strong>${escapeHtml(record.title || record.originalName)}</strong><small>${escapeHtml(record.summary || record.originalName || "")}</small></span>
    </button>`).join("")}</div>`;
}

function taskFromTarget(target) {
  if (!target) return null;
  return allTasksForPage().find((task) => task.id === target.id
    && task.sourceKind === target.sourceKind
    && String(task.recordId || "") === String(target.recordId || "")) || null;
}

function projectGroupName(project) {
  if (state.settings.projectGroupMode === "custom") {
    return state.settings.projectGroups?.find((group) => group.id === project.groupId)?.name || "未分组";
  }
  if (state.settings.projectGroupMode === "month") return monthGroupLabel(projectMonthKey(project));
  return "项目";
}

function renderProjectPickerList() {
  const list = $("#projectPickerList");
  if (!list) return;
  const searchInput = $("#projectPickerSearch");
  const createButton = $("#createProjectFromPicker");
  const createName = searchInput?.value.trim() || "";
  const query = normalizeSearch(createName);
  const duplicateName = Boolean(createName) && state.settings.projects.some((project) => normalizeSearch(project.name) === query);
  if (createButton) {
    createButton.disabled = !createName || duplicateName;
    createButton.textContent = !createName
      ? "＋ 新建项目"
      : duplicateName
        ? "项目已存在"
        : `＋ 新建“${createName.length > 18 ? `${createName.slice(0, 18)}…` : createName}”`;
  }
  const targetRecord = state.projectPickerTarget?.kind === "record"
    ? state.records.find((record) => record.id === state.projectPickerTarget.recordId)
    : null;
  const targetTask = state.projectPickerTarget?.kind === "task"
    ? taskFromTarget(state.projectPickerTarget)
    : null;
  const filterMode = state.projectPickerTarget?.kind === "filter";
  const selectedProjectId = filterMode ? state.projectFilter : (targetRecord?.projectId || targetTask?.projectId || "");
  const globalSelected = filterMode ? selectedProjectId === "__unassigned__" : Boolean((targetRecord || targetTask) && !selectedProjectId);
  const projects = projectsByRecentActivity().filter((project) => {
    const haystack = normalizeSearch([project.name, project.owner, ...(project.aliases || []), projectGroupName(project)].join(" "));
    return !query || haystack.includes(query);
  });
  const allMatches = !query || normalizeSearch("全部项目 所有项目").includes(query);
  const globalMatches = !query || normalizeSearch("跨项目 全局资料 无项目").includes(query);
  list.innerHTML = [
    filterMode && allMatches ? `<button type="button" class="selector-option special${selectedProjectId === "__all__" ? " selected" : ""}" data-project-picker-value="__all__"><span class="selector-option-mark">◉</span><span><strong>全部项目</strong><small>${selectedProjectId === "__all__" ? "当前选择 · " : ""}显示所有项目的记录</small></span></button>` : "",
    globalMatches ? `<button type="button" class="selector-option special${globalSelected ? " selected" : ""}" data-project-picker-value="${filterMode ? "__unassigned__" : ""}"><span class="selector-option-mark">◎</span><span><strong>跨项目 / 全局资料</strong><small>${globalSelected ? "当前选择 · " : ""}不归入任何单一项目</small></span></button>` : "",
    ...projects.map((project) => {
      const recordCount = state.records.filter((record) => record.projectId === project.id).length;
      const taskCount = tasksForProject(project.id).length;
      const current = project.id === selectedProjectId;
      return `<button type="button" class="selector-option${current ? " selected" : ""}" data-project-picker-value="${escapeHtml(project.id)}"><span class="selector-option-mark">◇</span><span><strong>${escapeHtml(project.name)}</strong><small>${current ? "当前选择 · " : ""}${escapeHtml(projectGroupName(project))} · ${recordCount} 份文件 · ${taskCount} 个任务${project.owner ? ` · ${escapeHtml(project.owner)}` : ""}</small></span></button>`;
    }),
  ].join("") || `<div class="task-linked-empty">没有找到匹配的项目。</div>`;
}

function openProjectPicker(target) {
  state.projectPickerTarget = target;
  const record = target?.kind === "record" ? state.records.find((item) => item.id === target.recordId) : null;
  const task = target?.kind === "task" ? taskFromTarget(target) : null;
  $("#projectPickerHint").textContent = target?.kind === "batch"
    ? `为已选的 ${state.batchSelection.size} 条记录设置同一个项目。`
    : target?.kind === "filter"
      ? "选择需要查看的项目，也可以输入名称快速搜索。"
    : target?.kind === "task"
      ? `选择任务“${task?.text || "未命名任务"}”所属的项目。`
      : `选择“${record?.title || record?.originalName || "这条记录"}”所属的项目。`;
  $("#projectPickerSearch").value = "";
  renderProjectPickerList();
  $("#projectPickerDialog").showModal();
  setTimeout(() => $("#projectPickerSearch").focus(), 0);
}

function closeProjectPicker() {
  state.projectPickerTarget = null;
  $("#projectPickerDialog").close();
}

function renderTaskLinkList() {
  const task = taskFromTarget(state.taskLinkTarget);
  const list = $("#taskLinkList");
  if (!task || !list) return;
  const query = $("#taskLinkSearch")?.value.trim().toLowerCase() || "";
  const sourceId = task.sourceKind === "record" ? task.recordId : "";
  const matching = state.records.filter((record) => {
    return !query || recordSearchText(record).includes(query);
  }).sort((a, b) => Number(state.taskLinkRecordIds.has(b.id)) - Number(state.taskLinkRecordIds.has(a.id)));
  const visible = matching.slice(0, 200);
  list.innerHTML = visible.length ? visible.map((record) => {
    const fixed = record.id === sourceId;
    const project = state.settings.projects.find((item) => item.id === record.projectId)?.name || "跨项目资料";
    return `<label class="task-link-choice${fixed ? " fixed" : ""}">
      <input type="checkbox" data-task-link-record="${escapeHtml(record.id)}" ${state.taskLinkRecordIds.has(record.id) ? "checked" : ""} ${fixed ? "disabled" : ""} />
      <span><strong>${escapeHtml(record.title || record.originalName)}</strong><small>${escapeHtml(project)}${fixed ? " · 来源文件（固定关联）" : ""}</small></span>
    </label>`;
  }).join("") + (matching.length > visible.length ? `<div class="selector-more">还有 ${matching.length - visible.length} 份文件，请输入更具体的关键词。</div>` : "") : `<div class="task-linked-empty">没有找到匹配的文件。</div>`;
  $("#saveTaskLinks").textContent = `保存关联（${state.taskLinkRecordIds.size}）`;
}

function openTaskLinkDialog(task) {
  state.taskLinkTarget = { sourceKind: task.sourceKind, id: task.id, recordId: task.recordId || "" };
  state.taskLinkRecordIds = new Set(linkedRecordIds(task));
  $("#taskLinkTask").textContent = task.text;
  $("#taskLinkSearch").value = "";
  renderTaskLinkList();
  $("#taskLinkDialog").showModal();
}

async function createAndLinkOfficeFile(task, type, button) {
  if (!task || !["docx", "xlsx", "pptx"].includes(type)) return;
  if (!state.settings?.libraryPath) {
    toast("请先选择工作资料库", true);
    return;
  }
  const typeName = { docx: "Word", xlsx: "Excel", pptx: "PPT" }[type];
  if (button) button.disabled = true;
  try {
    const record = await window.worktrace.createOfficeFile({
      type,
      title: task.text || `新建${typeName}文件`,
      projectId: task.projectId || "",
    });
    state.records.unshift(record);
    const recordIds = [...new Set([...linkedRecordIds(task), record.id])];
    if (task.sourceKind === "record") {
      const sourceRecord = state.records.find((item) => item.id === task.recordId);
      if (!sourceRecord) throw new Error("没有找到任务的来源文件");
      const taskItems = taskItemsFor(sourceRecord).map((item) => item.id === task.id ? { ...item, recordIds } : { ...item });
      const updatedRecord = await window.worktrace.updateRecord({ id: sourceRecord.id, taskItems });
      const sourceIndex = state.records.findIndex((item) => item.id === sourceRecord.id);
      if (sourceIndex >= 0) state.records[sourceIndex] = { ...state.records[sourceIndex], ...updatedRecord };
    } else {
      const updated = await window.worktrace.updateTask({ id: task.id, recordIds });
      const index = state.manualTasks.findIndex((item) => item.id === updated.id);
      if (index >= 0) state.manualTasks[index] = updated;
    }
    render();
    toast(`${typeName} 文件已新建并关联，正在打开`);
    try {
      await window.worktrace.openFile(record.storedPath);
    } catch (openError) {
      toast(`文件已创建，但没有自动打开：${openError.message}`, true);
    }
  } catch (error) {
    await refresh().catch(() => {});
    toast(error.message, true);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function closeTaskLinkDialog() {
  state.taskLinkTarget = null;
  state.taskLinkRecordIds = new Set();
  $("#taskLinkDialog").close();
}

function taskByKey(key) {
  return allTasksForPage().find((task) => taskKey(task) === key) || null;
}

function renderRecordTaskList() {
  const record = state.records.find((item) => item.id === state.recordTaskTargetId);
  const list = $("#recordTaskList");
  if (!record || !list) return;
  const query = normalizeSearch($("#recordTaskSearch")?.value);
  const matches = allTasksForPage().filter((task) => {
    const projectName = state.settings.projects.find((project) => project.id === task.projectId)?.name || "无项目";
    const files = linkedRecords(task).map((item) => item.title || item.originalName).join(" ");
    return !query || normalizeSearch([task.text, task.dueDate, projectName, files].join(" ")).includes(query);
  }).sort((a, b) => Number(state.recordTaskSelection.has(taskKey(b))) - Number(state.recordTaskSelection.has(taskKey(a))) || compareTaskPriority(a, b));
  const visible = matches.slice(0, 200);
  list.innerHTML = visible.length ? visible.map((task) => {
    const key = taskKey(task);
    const fixed = task.sourceKind === "record" && task.recordId === record.id;
    const projectName = state.settings.projects.find((project) => project.id === task.projectId)?.name || "无项目";
    const linkedCount = linkedRecordIds(task).length;
    return `<label class="project-task-choice${task.completed ? " completed" : ""}${fixed ? " fixed" : ""}">
      <input type="checkbox" data-record-task-key="${escapeHtml(key)}" ${state.recordTaskSelection.has(key) ? "checked" : ""} ${fixed ? "disabled" : ""} />
      <span><strong>${escapeHtml(task.text)}</strong><small>${escapeHtml(projectName)}${task.dueDate ? ` · 截止 ${escapeHtml(task.dueDate)}` : ""} · ${linkedCount} 个关联文件${fixed ? " · 从本文件识别（固定关联）" : ""}</small></span>
    </label>`;
  }).join("") + (matches.length > visible.length ? `<div class="selector-more">还有 ${matches.length - visible.length} 项任务，请输入更具体的关键词。</div>` : "") : `<div class="task-linked-empty">没有找到匹配的任务。可以在下方直接新建。</div>`;
  $("#saveRecordTasks").textContent = `保存关联（${state.recordTaskSelection.size}）`;
}

function openRecordTaskDialog(recordId, focusCreate = false) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  state.recordTaskTargetId = record.id;
  state.recordTaskSelection = new Set(tasksLinkedToRecord(record.id).map(taskKey));
  $("#recordTaskName").textContent = `文件：${record.title || record.originalName}`;
  $("#recordTaskSearch").value = "";
  $("#recordTaskNewText").value = "";
  $("#recordTaskNewDue").value = "";
  renderRecordTaskList();
  $("#recordTaskDialog").showModal();
  setTimeout(() => (focusCreate ? $("#recordTaskNewText") : $("#recordTaskSearch")).focus(), 0);
}

function closeRecordTaskDialog() {
  state.recordTaskTargetId = "";
  state.recordTaskSelection = new Set();
  $("#recordTaskDialog").close();
}

async function updateTaskRecordLink(task, record, shouldLink) {
  const recordIds = new Set(linkedRecordIds(task));
  if (shouldLink) recordIds.add(record.id);
  else recordIds.delete(record.id);
  if (task.sourceKind === "record") {
    if (task.recordId === record.id && !shouldLink) return;
    const sourceRecord = state.records.find((item) => item.id === task.recordId);
    if (!sourceRecord) return;
    const taskItems = taskItemsFor(sourceRecord).map((item) => item.id === task.id
      ? {
          ...item,
          recordIds: [...recordIds],
          ...(!task.projectId && record.projectId ? { projectId: record.projectId, projectIdExplicit: true } : {}),
        }
      : item);
    const updated = await window.worktrace.updateRecord({ id: sourceRecord.id, taskItems });
    const index = state.records.findIndex((item) => item.id === sourceRecord.id);
    if (index >= 0) state.records[index] = { ...state.records[index], ...updated };
    return;
  }
  const updated = await window.worktrace.updateTask({
    id: task.id,
    recordIds: [...recordIds],
    ...(!task.projectId && record.projectId ? { projectId: record.projectId } : {}),
  });
  const index = state.manualTasks.findIndex((item) => item.id === updated.id);
  if (index >= 0) state.manualTasks[index] = updated;
}

function allTasksForPage() {
  const manual = state.manualTasks.map((task) => ({ ...task, sourceKind: "manual", recordIds: task.recordIds || [], sourceLabel: "手工添加" }));
  const extracted = state.records.flatMap((record) => taskItemsFor(record).map((task) => ({
    ...task,
    sourceKind: "record",
    record,
    recordId: record.id,
    projectId: task.projectIdExplicit ? task.projectId : (record.projectId || ""),
    owner: task.owner || record.owners?.[0] || "",
    dueDate: task.dueDate || "",
    recordIds: [...new Set([record.id, ...(task.recordIds || [])])],
    sourceLabel: `来自资料：${record.title || record.originalName}`,
  })));
  return [...manual, ...extracted];
}

function tasksForProject(projectId) {
  const projectRecordIds = new Set(state.records.filter((record) => record.projectId === projectId).map((record) => record.id));
  return allTasksForPage().filter((task) => task.projectId === projectId
    || linkedRecordIds(task).some((recordId) => projectRecordIds.has(recordId)));
}

function unassignedTasks() {
  return allTasksForPage().filter((task) => !task.projectId);
}

function compareTaskPriority(a, b) {
  if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
  const aRanked = typeof a.sortOrder === "number" && Number.isFinite(a.sortOrder);
  const bRanked = typeof b.sortOrder === "number" && Number.isFinite(b.sortOrder);
  if (aRanked && bRanked && a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  // A newly added task has no saved rank yet and should appear above an
  // already arranged list until the user drags again.
  if (aRanked !== bRanked) return aRanked ? 1 : -1;
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate) return -1;
  if (b.dueDate) return 1;
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

function renderProjectTaskPicker() {
  const list = $("#projectTaskPickerList");
  if (!list) return;
  const query = $("#projectTaskPickerSearch")?.value.trim().toLowerCase() || "";
  const matchingTasks = unassignedTasks().filter((task) => {
    return !query || taskSearchText(task).includes(query);
  }).sort((a, b) => Number(state.projectTaskSelection.has(taskKey(b))) - Number(state.projectTaskSelection.has(taskKey(a))));
  const tasks = matchingTasks.slice(0, 200);
  list.innerHTML = tasks.length ? tasks.map((task) => {
    const key = taskKey(task);
    const files = linkedRecords(task);
    return `<label class="project-task-choice${task.completed ? " completed" : ""}">
      <input type="checkbox" data-project-task-pick="${escapeHtml(key)}" ${state.projectTaskSelection.has(key) ? "checked" : ""} />
      <span><strong>${escapeHtml(task.text)}</strong><small>${task.completed ? "已完成" : task.dueDate ? `截止 ${escapeHtml(task.dueDate)}` : "未设置截止日期"}${files.length ? ` · ${files.length} 个关联文件` : ""}</small></span>
    </label>`;
  }).join("") + (matchingTasks.length > tasks.length ? `<div class="selector-more">还有 ${matchingTasks.length - tasks.length} 个任务，请输入更具体的关键词。</div>` : "") : `<div class="task-linked-empty">${query ? "没有找到匹配的未归项目任务。" : "目前没有未归项目的任务。"}</div>`;
  $("#assignProjectTasks").disabled = state.projectTaskSelection.size === 0;
  $("#assignProjectTasks").textContent = state.projectTaskSelection.size ? `加入当前项目（${state.projectTaskSelection.size}）` : "加入当前项目";
}

function openProjectTaskPicker(projectId) {
  const project = state.settings.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.projectTaskPickerProjectId = projectId;
  state.projectTaskSelection = new Set();
  $("#projectTaskPickerName").textContent = `加入项目：${project.name}`;
  $("#projectTaskPickerSearch").value = "";
  renderProjectTaskPicker();
  $("#projectTaskPickerDialog").showModal();
}

function closeProjectTaskPicker() {
  state.projectTaskPickerProjectId = "";
  state.projectTaskSelection = new Set();
  $("#projectTaskPickerDialog").close();
}

async function assignTasksToProject(selectedTasks, projectId) {
  const manualTasks = selectedTasks.filter((task) => task.sourceKind === "manual");
  const recordTaskIds = new Map();
  selectedTasks.filter((task) => task.sourceKind === "record").forEach((task) => {
    const ids = recordTaskIds.get(task.recordId) || new Set();
    ids.add(task.id);
    recordTaskIds.set(task.recordId, ids);
  });
  await Promise.all([
    ...manualTasks.map((task) => window.worktrace.updateTask({ id: task.id, projectId })),
    ...[...recordTaskIds].map(([recordId, taskIds]) => {
      const record = state.records.find((item) => item.id === recordId);
      if (!record) throw new Error("没有找到任务的来源文件");
      const taskItems = taskItemsFor(record).map((task) => taskIds.has(task.id)
        ? { ...task, projectId, projectIdExplicit: true }
        : { ...task });
      return window.worktrace.updateRecord({ id: recordId, taskItems });
    }),
  ]);
  [state.records, state.manualTasks] = await Promise.all([window.worktrace.listRecords(), window.worktrace.listTasks()]);
}

function renderTaskProjectCreateList() {
  const tasks = unassignedTasks();
  $("#taskProjectCreateList").innerHTML = tasks.length ? tasks.map((task) => {
    const key = taskKey(task);
    const files = linkedRecords(task);
    return `<label class="project-task-choice${task.completed ? " completed" : ""}">
      <input type="checkbox" data-task-project-create="${escapeHtml(key)}" ${state.taskProjectCreateSelection.has(key) ? "checked" : ""} />
      <span><strong>${escapeHtml(task.text)}</strong><small>${task.completed ? "已完成" : task.dueDate ? `截止 ${escapeHtml(task.dueDate)}` : "未设置截止日期"}${files.length ? ` · ${files.length} 个关联文件` : ""}</small></span>
    </label>`;
  }).join("") : `<div class="task-linked-empty">目前没有未归项目的任务。</div>`;
  const hasName = Boolean($("#taskProjectName")?.value.trim());
  $("#confirmTaskProjectCreate").disabled = !hasName || state.taskProjectCreateSelection.size === 0;
  $("#confirmTaskProjectCreate").textContent = state.taskProjectCreateSelection.size ? `创建项目（${state.taskProjectCreateSelection.size} 个任务）` : "创建项目";
}

function openTaskProjectCreateDialog() {
  state.taskProjectCreateSelection = new Set();
  $("#taskProjectCreateForm").reset();
  renderTaskProjectCreateList();
  $("#taskProjectCreateDialog").showModal();
  setTimeout(() => $("#taskProjectName").focus(), 0);
}

function closeTaskProjectCreateDialog() {
  state.taskProjectCreateSelection = new Set();
  $("#taskProjectCreateDialog").close();
}

function renderTaskPage() {
  const tasks = allTasksForPage();
  const query = normalizeSearch(state.taskQuery);
  const today = dayKey(new Date().toISOString());

  $$('[data-task-status]').forEach((button) => button.classList.toggle("active", button.dataset.taskStatus === state.taskStatus));

  const visible = tasks.filter((task) => {
    const matchesStatus = query || state.taskStatus === "all"
      || (state.taskStatus === "completed" ? task.completed : !task.completed);
    return matchesStatus && (!query || taskSearchText(task).includes(query));
  }).sort(compareTaskPriority);

  $("#taskPageList").innerHTML = visible.length ? visible.map((task) => {
    const dueToday = !task.completed && task.dueDate && task.dueDate === today;
    const overdue = !task.completed && task.dueDate && task.dueDate < today;
    const key = taskKey(task);
    const expanded = state.expandedTaskKeys.has(key);
    const linked = linkedRecords(task);
    const projectName = state.settings.projects.find((project) => project.id === task.projectId)?.name || "无项目";
    return `
      <article class="task-page-row${task.completed ? " completed" : ""}${dueToday ? " due-today" : ""}${overdue ? " overdue" : ""}${expanded ? " links-open" : ""}" data-task-kind="${task.sourceKind}" data-task-id="${escapeHtml(task.id)}" data-record-id="${escapeHtml(task.recordId || "")}" data-task-key="${escapeHtml(key)}" data-task-completed="${task.completed ? "1" : "0"}">
        <button type="button" class="task-drag-handle${query ? " disabled" : ""}" data-task-drag-handle draggable="${query ? "false" : "true"}" aria-label="拖动调整任务优先级" title="${query ? "清空搜索后可以拖动排序" : "按住拖动，调整任务优先级"}">⠿</button>
        <input type="checkbox" data-page-task-toggle ${task.completed ? "checked" : ""} aria-label="标记任务完成" />
        <div class="task-page-main">
          <input class="task-page-text" data-page-task-text maxlength="300" value="${escapeHtml(task.text)}" aria-label="编辑任务内容" />
          <span>${escapeHtml(task.sourceLabel)}${dueToday ? " · 今天截止" : overdue ? " · 已逾期" : ""}</span>
          <div class="task-quick-actions">
            <button type="button" class="secondary compact task-project-button" data-edit-task-project>项目：${escapeHtml(projectName)}</button>
            <button type="button" class="secondary compact" data-edit-task-files>选择已有文件</button>
            <details class="new-office-menu">
              <summary>新建文件</summary>
              <div>
                <button type="button" data-create-task-file="docx"><b>W</b><span>Word 文档</span></button>
                <button type="button" data-create-task-file="xlsx"><b>X</b><span>Excel 表格</span></button>
                <button type="button" data-create-task-file="pptx"><b>P</b><span>PPT 演示文稿</span></button>
              </div>
            </details>
            <button type="button" class="task-file-link" data-toggle-task-files>${linked.length} 个关联文件 ${expanded ? "▴" : "▾"}</button>
          </div>
        </div>
        <label>截止日期<input data-page-task-due type="date" value="${escapeHtml(task.dueDate || "")}" /></label>
        <button class="task-delete" data-page-task-delete>删除</button>
        ${expanded ? `<div class="task-linked-panel"><div class="task-linked-head"><strong>关联文件</strong><button type="button" class="secondary compact" data-edit-task-files>添加或删减</button></div>${renderLinkedFiles(task)}</div>` : ""}
      </article>`;
  }).join("") : `<div class="task-empty large">${query ? "没有找到匹配的任务。可以尝试文件名、任务内容或项目名称。" : "当前筛选条件下没有任务，可以在上方手工添加。"}</div>`;
}

function render() {
  refreshAssistantEntry();
  renderFilters();
  renderProjectFilter();
  const fileQuery = normalizeSearch(state.fileQuery);
  const fileSearchMode = state.view === "today" && Boolean(fileQuery);
  const today = dayKey(new Date().toISOString());
  const isTimeline = state.view === "timeline";
  const isTaskPage = isTimeline && state.timelineMode === "tasks";
  const projectMode = isTimeline && state.timelineMode === "project";
  const projectOverviewPage = projectMode && state.projectPage === "overview" && state.projectFilter !== "__unassigned__";

    const visibleAll = state.records.filter((record) => {
    if (fileSearchMode) return recordSearchText(record).includes(fileQuery);
    const matchesFilter = state.filter === "全部" || record.category === state.filter;
    const matchesView = isTimeline || recordDay(record) === today;
    const matchesDate = !isTimeline || !state.recordDateFilter || recordDay(record) === state.recordDateFilter;
    const projectListFilterActive = projectMode && !projectOverviewPage && state.projectFilter !== "__all__";
    const matchesProject = (!projectOverviewPage && !projectListFilterActive)
      || (state.projectFilter === "__unassigned__" ? !record.projectId : record.projectId === state.projectFilter);
    return matchesView && matchesDate && matchesProject && matchesFilter;
  }).sort((a, b) => recordDay(b).localeCompare(recordDay(a)) || b.createdAt.localeCompare(a.createdAt));

    // 「文件」视图只列当天记录；要看全部记录就点「全部记录 →」走时间线
  const visible = visibleAll;

  const activeNavView = isTaskPage ? "tasks" : state.view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === activeNavView));
  $$("[data-timeline-mode]").forEach((item) => item.classList.toggle("active", item.dataset.timelineMode === state.timelineMode));
  $("#fileSearchWrap").classList.toggle("hidden", state.view !== "today");
  $("#openFullTimeline").classList.toggle("hidden", state.view !== "today");
  if (isTaskPage) {
    $("#pageTitle").textContent = "任务列表";
    $("#todayLabel").textContent = "TASKS · 可手工编辑的任务工作区";
    $("#timelineDateWrap").classList.add("hidden");
    $("#dropZone").classList.add("hidden");
    $("#timelineToolbar").classList.remove("hidden");
    $("#projectFilterWrap").classList.add("hidden");
    $("#projectPageTabs").classList.add("hidden");
    $("#recordSectionHead").classList.add("hidden");
    $("#records").classList.add("hidden");
    $("#emptyState").classList.add("hidden");
    $("#projectOverview").classList.add("hidden");
    $("#projectDetail").classList.add("hidden");
    $("#taskPage").classList.remove("hidden");
    renderTaskPage();
    return;
  }
  $("#taskPage").classList.add("hidden");
  $("#recordSectionHead").classList.remove("hidden");
  $$("[data-project-page]").forEach((item) => item.classList.toggle("active", item.dataset.projectPage === state.projectPage));
  $("#pageTitle").textContent = projectOverviewPage ? "项目概览" : isTimeline ? (projectMode ? "项目管理" : "全部工作记录") : "今天的工作记录";
  $("#recordHeading").textContent = projectOverviewPage ? "项目进展与待办" : isTimeline ? (projectMode ? "按项目查看记录" : "按发生日期排列") : fileSearchMode ? "搜索结果" : "最近记录";
  $("#todayLabel").textContent = isTimeline
    ? "LOCAL ARCHIVE · 本地资料库"
    : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());
  const contextProjectId = activeProjectId();
  $("#dropZone").classList.toggle("hidden", isTimeline && (!contextProjectId || projectOverviewPage));
  const dropTitle = $("#dropZone h2");
  if (dropTitle) {
    const contextProject = contextProjectId ? state.settings.projects.find((item) => item.id === contextProjectId) : null;
    dropTitle.textContent = contextProject ? `添加到「${contextProject.name}」` : "添加资料";
  }
  $("#timelineToolbar").classList.toggle("hidden", !isTimeline);
  $("#timelineDateWrap").classList.toggle("hidden", !isTimeline || projectOverviewPage);
  $("#timelineDateInput").value = state.recordDateFilter;
  $("#clearTimelineDate").classList.toggle("hidden", !state.recordDateFilter);
  $("#projectFilterWrap").classList.toggle("hidden", !projectMode); // 项目概览里也要能切换项目
  $("#projectPageTabs").classList.toggle("hidden", !projectOverviewPage);
  $("#filters").classList.toggle("hidden", projectOverviewPage);
  $("#recordCount").textContent = `${visibleAll.length} 条`;

  if (projectMode && !projectOverviewPage) {
    $("#records").innerHTML = renderProjectGroups(visible);
  } else if (isTimeline) {
    const groups = visible.reduce((result, record) => {
      const key = recordDay(record);
      (result[key] ||= []).push(record);
      return result;
    }, {});
    $("#records").innerHTML = Object.entries(groups).map(([key, records]) => `
      <section class="timeline-group">
        <div class="timeline-date"><strong>${dateGroupLabel(key)}</strong><span>${records.length} 条记录</span></div>
        <div class="timeline-items">${records.map(renderRecord).join("")}</div>
      </section>`).join("");
  } else {
    $("#records").innerHTML = visible.map(renderRecord).join("");
  }

  const fullProjectRecords = projectMode
    ? state.records.filter((record) => state.projectFilter === "__unassigned__" ? !record.projectId : record.projectId === state.projectFilter)
      .sort((a, b) => recordDay(b).localeCompare(recordDay(a)) || b.createdAt.localeCompare(a.createdAt))
    : visible;
  renderProjectOverview(fullProjectRecords);
  renderProjectDetail(fullProjectRecords);
  $("#emptyState h3").textContent = projectOverviewPage ? "这个项目还没有记录" : fileSearchMode ? "没有找到匹配的记录" : state.recordDateFilter ? "这一天没有记录" : projectMode ? "还没有可以按项目展示的记录" : isTimeline ? "这里还没有工作记录" : "今天还没有记录";
  $("#emptyState p").textContent = fileSearchMode ? "可以尝试文件名、正文内容、标签或任务里的关键词。" : state.recordDateFilter ? "可以换一天，或点击“全部日期”恢复完整记录。" : isTimeline ? "回到“今天”，添加资料或调整记录所属项目。" : "添加第一份工作资料，看看本地读取和自动整理的效果。";
  const hasPrimaryContent = projectMode && !projectOverviewPage
    ? (state.recordDateFilter || state.projectFilter !== "__all__" ? visible.length > 0 : state.settings.projects.length > 0 || visible.length > 0)
    : visible.length > 0;
  $("#emptyState").classList.toggle("hidden", projectOverviewPage || hasPrimaryContent);
  $("#records").classList.toggle("hidden", projectOverviewPage || !hasPrimaryContent);
  $("#records").classList.toggle("batch-on", state.batchMode);

  if (state.editingTitleId) {
    const input = document.querySelector(`[data-title-input="${state.editingTitleId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }

  if (state.renamingProjectId) {
    const input = document.querySelector(`[data-rename-input="${state.renamingProjectId}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    [state.settings, state.records, state.manualTasks] = await Promise.all([
      window.worktrace.getSettings(),
      window.worktrace.listRecords(),
      window.worktrace.listTasks(),
    ]);
    $("#setupBanner").classList.toggle("hidden", Boolean(state.settings.libraryPath));
    $("#pickFiles").disabled = !state.settings.libraryPath;
    render();
    return state.settings;
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function ensureReady() {
  if (state.settings) return true;
  try {
    await refresh();
    return Boolean(state.settings);
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}

async function chooseLibrary() {
  const result = await window.worktrace.chooseLibrary();
  if (result) {
    state.settings = result;
    state.records = await window.worktrace.listRecords();
    state.manualTasks = await window.worktrace.listTasks();
    $("#setupBanner").classList.add("hidden");
    $("#pickFiles").disabled = false;
    toast(result.scan?.total ? `已识别 ${result.scan.total} 个现有文件` : "工作文件夹已设置");
    render();
  }
}

async function importPaths(paths, projectId = "") {
  if (!paths.length) return;
  if (!state.settings?.libraryPath) {
    toast("请先选择工作资料库", true);
    return;
  }
  state.pendingImports += 1;
  $("#progressWrap").classList.remove("hidden");
  $("#progressText").textContent = state.pendingImports > 1 ? `已在队列中排队（共 ${state.pendingImports} 批），前面处理完会自动继续…` : "准备处理";
  try {
    const records = await window.worktrace.importFiles(paths, "", projectId);
    if (records.length) {
      state.records = [...records, ...state.records];
      state.recentIds = new Set(records.map((record) => record.id));
      render();
      clearTimeout(importPaths.highlightTimer);
      importPaths.highlightTimer = setTimeout(() => {
        state.recentIds.clear();
        render();
      }, 12000);
      const categories = [...new Set(records.map((record) => record.category).filter(Boolean))].join("、");
      toast(categories ? `已移动并归档 ${records.length} 份资料，标签：${categories}` : `已移动并归档 ${records.length} 份资料`);
    } else {
      toast("未导入文件（可能已取消）");
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.pendingImports = Math.max(0, state.pendingImports - 1);
    if (state.pendingImports === 0) {
      $("#progressBar").style.width = "100%";
      $("#progressText").textContent = "整理完成，可以继续选择或拖入更多文件";
      setTimeout(() => $("#progressWrap").classList.add("hidden"), 2400);
    } else {
      $("#progressText").textContent = `还有 ${state.pendingImports} 批文件在排队处理…`;
    }
  }
}

function renderCategorySettings(categories) {
  $("#categoryList").innerHTML = categories.map((category) => `
    <div class="editable-row" data-category-row data-id="${escapeHtml(category.id)}">
      <input value="${escapeHtml(category.name)}" placeholder="标签名称" maxlength="30"${category.id === "other" ? " disabled" : ""} />
      ${category.id === "other" ? '<span class="fixed-row">固定</span>' : '<button type="button" class="remove-row" data-remove-category>删除</button>'}
    </div>`).join("");
}

function syncProviderUi(providerKey, keepModel = false) {
  const preset = state.settings.providers?.[providerKey] || { baseUrl: "", model: "", requiresKey: true, models: [] };
  const models = Array.isArray(preset.models) ? preset.models : [];
  $("#modelOptions").innerHTML = models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("");
  const isCustom = providerKey === "custom";
  $("#baseUrlRow").classList.toggle("hidden", !isCustom);
  if (isCustom) {
    $("#baseUrl").value = state.settings.baseUrl || "";
    $("#model").value = keepModel ? (state.settings.model || "") : "";
  } else {
    $("#baseUrl").value = preset.baseUrl || "";
    const candidates = models.concat([preset.model || ""]);
    const saved = keepModel && state.settings.provider === providerKey ? state.settings.model : "";
    $("#model").value = saved && candidates.includes(saved) ? saved : (models[0] || preset.model || "");
  }
  $("#apiKey").disabled = !preset.requiresKey;
}

function populateSettings() {
  const settings = state.settings;
  state.aiTestPassed = Boolean(settings.aiVerified);
  const select = $("#provider");
  const labels = { deepseek: "DeepSeek", qwen: "通义千问", openai: "OpenAI", ollama: "本地 Ollama", custom: "自定义兼容接口" };
  select.innerHTML = Object.keys(settings.providers).map((key) => `<option value="${key}">${labels[key]}</option>`).join("");
  select.value = settings.provider;
  syncProviderUi(settings.provider, true);
  $("#libraryPath").textContent = settings.libraryPath || "尚未选择";
  $("#categoriesEnabled").checked = settings.categoriesEnabled;
  $("#categoryList").classList.toggle("categories-disabled", !settings.categoriesEnabled);
  renderCategorySettings(settings.categories);
  $("#aiEnabled").checked = settings.aiEnabled;
  $("#visionEnabled").checked = settings.visionEnabled;
  $("#visionNotice").classList.toggle("hidden", !settings.visionEnabled);
  $("#apiKey").value = "";
  $("#apiKey").placeholder = settings.hasApiKey ? "已安全保存；留空则不更改" : "粘贴服务商提供的 API 密钥";
  $("#keyHint").textContent = settings.aiVerified
    ? "连接已经验证。修改服务商、模型或 Key 后，点击保存会重新检查。"
    : settings.hasApiKey ? "密钥已经保存；点击保存会自动检查。也可以直接粘贴 KEY=… 或带引号的 Key。" : "可直接粘贴 Key；首尾空格、引号和 KEY= 前缀会自动处理。密钥由系统安全存储。";
  setTestResult(settings.aiVerified ? "AI 已连接，可以使用" : "保存时会自动检查连接", settings.aiVerified ? "success" : "neutral");
  $("#aiFields").style.opacity = settings.aiEnabled ? "1" : ".55";
}

function readCategorySettings() {
  return $$("[data-category-row]").map((row) => ({ id: row.dataset.id, name: row.querySelector("input").value }));
}

function formValue() {
  return {
    aiEnabled: $("#aiEnabled").checked,
    visionEnabled: $("#visionEnabled").checked,
    provider: $("#provider").value,
    baseUrl: $("#baseUrl").value,
    model: $("#model").value,
    apiKey: $("#apiKey").value,
    aiVerified: state.aiTestPassed,
    categoriesEnabled: $("#categoriesEnabled").checked,
    categories: readCategorySettings(),
    projects: state.settings.projects,
  };
}

async function updateManualTask(id, changes, successMessage) {
  try {
    const updated = await window.worktrace.updateTask({ id, ...changes });
    const index = state.manualTasks.findIndex((item) => item.id === updated.id);
    if (index >= 0) state.manualTasks[index] = updated;
    render();
    if (successMessage) toast(successMessage);
  } catch (error) {
    toast(error.message, true);
    render();
  }
}

async function removeManualTask(id) {
  try {
    await window.worktrace.deleteTask(id);
    state.manualTasks = state.manualTasks.filter((item) => item.id !== id);
    render();
    toast("待办已删除");
  } catch (error) {
    toast(error.message, true);
  }
}

async function updateRecord(id, changes, successMessage) {
  try {
    const updated = await window.worktrace.updateRecord({ id, ...changes });
    const index = state.records.findIndex((record) => record.id === id);
    if (index >= 0) state.records[index] = { ...state.records[index], ...updated };
    render();
    if (successMessage) toast(successMessage);
  } catch (error) {
    toast(error.message, true);
  }
}

function copyProjectManagerDraft() {
  return {
    mode: state.settings.projectGroupMode || "none",
    groups: (state.settings.projectGroups || []).map((group) => ({ ...group })),
    projects: state.settings.projects.map((project) => ({ ...project, aliases: [...(project.aliases || [])] })),
  };
}

function projectMonthKey(project) {
  const candidates = [];
  if (project.createdAt) candidates.push(project.createdAt);
  state.records.filter((record) => record.projectId === project.id)
    .forEach((record) => candidates.push(record.eventDate || record.createdAt));
  state.manualTasks.filter((task) => task.projectId === project.id)
    .forEach((task) => candidates.push(task.createdAt || task.updatedAt));
  const valid = candidates.map((value) => String(value || "")).filter((value) => /^\d{4}-\d{2}/.test(value)).sort();
  return valid[0]?.slice(0, 7) || "unknown";
}

function monthGroupLabel(key) {
  if (key === "unknown") return "月份未记录";
  const [year, month] = key.split("-").map(Number);
  return `${year}年${month}月`;
}

function readProjectManager() {
  return $$('[data-manager-project]').map((row) => {
    const name = row.querySelector('[data-manager-field="name"]')?.value || "";
    const owner = row.querySelector('[data-manager-field="owner"]')?.value || "";
    const aliases = row.querySelector('[data-manager-field="aliases"]')?.value || "";
    const groupId = row.querySelector("[data-manager-group-select]")?.value ?? row.dataset.groupId ?? "";
    return { id: row.dataset.id, name, owner, aliases, groupId, createdAt: row.dataset.createdAt || "" };
  });
}

function syncProjectManagerDraftFromDom() {
  if (!state.projectManagerDraft) return;
  const visibleProjects = readProjectManager();
  if (visibleProjects.length || !state.projectManagerDraft.projects.length) state.projectManagerDraft.projects = visibleProjects;
  const groupInputs = $$('[data-manager-group-name]');
  if (groupInputs.length || !state.projectManagerDraft.groups.length) {
    state.projectManagerDraft.groups = groupInputs.map((input) => ({ id: input.dataset.managerGroupName, name: input.value }));
  }
}

function managerProjectRow(project, customMode) {
  const groupOptions = (state.projectManagerDraft?.groups || []).map((group) =>
    `<option value="${escapeHtml(group.id)}"${selected(project.groupId || "", group.id)}>${escapeHtml(group.name)}</option>`,
  ).join("");
  return `<div class="manager-project-row" data-manager-project data-id="${escapeHtml(project.id)}" data-group-id="${escapeHtml(project.groupId || "")}" data-created-at="${escapeHtml(project.createdAt || "")}">
    <button type="button" class="manager-project-mark" data-manager-open aria-label="打开项目概览">◇</button>
    <label>项目名称<input data-manager-field="name" value="${escapeHtml(project.name)}" maxlength="80" placeholder="项目名称" /></label>
    <label>负责人<input data-manager-field="owner" value="${escapeHtml(project.owner || "")}" maxlength="60" placeholder="可不填" /></label>
    <label>项目别名<input data-manager-field="aliases" value="${escapeHtml(Array.isArray(project.aliases) ? project.aliases.join("、") : (project.aliases || ""))}" placeholder="多个名称用逗号分隔" /></label>
    ${customMode ? `<label class="manager-project-group">显示分组<select data-manager-group-select><option value="">未分组</option>${groupOptions}</select></label>` : ""}
    <div class="manager-project-actions"><button type="button" class="secondary compact" data-manager-open>打开概览</button><button type="button" class="task-delete" data-manager-remove>删除</button></div>
  </div>`;
}

function renderProjectManager() {
  const draft = state.projectManagerDraft || copyProjectManagerDraft();
  state.projectManagerDraft = draft;
  const mode = draft.mode || "none";
  $("#projectGroupingMode").value = mode;
  $("#managerCustomGroups").classList.toggle("hidden", mode !== "custom");
  $("#managerGroupList").innerHTML = draft.groups.length ? draft.groups.map((group) => `
    <div class="manager-group-item">
      <input data-manager-group-name="${escapeHtml(group.id)}" value="${escapeHtml(group.name)}" maxlength="40" aria-label="分组名称" />
      <button type="button" class="task-delete" data-manager-group-remove="${escapeHtml(group.id)}">删除</button>
    </div>`).join("") : `<p class="manager-group-empty">还没有自定义分组。先新建一个名称，再把项目放进去。</p>`;

  let sections;
  if (mode === "month") {
    const groups = new Map();
    draft.projects.forEach((project) => {
      const key = projectMonthKey(project);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(project);
    });
    sections = [...groups.entries()].sort(([a], [b]) => {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      return b.localeCompare(a);
    });
  } else if (mode === "custom") {
    const byGroup = new Map(draft.groups.map((group) => [group.id, []]));
    byGroup.set("", []);
    draft.projects.forEach((project) => (byGroup.get(byGroup.has(project.groupId) ? project.groupId : "") || byGroup.get("")).push(project));
    sections = [
      ...draft.groups.map((group) => [group.id, byGroup.get(group.id) || []]),
      ["", byGroup.get("") || []],
    ].filter(([, projects]) => projects.length);
  } else {
    sections = [["all", draft.projects]];
  }

  $("#projectManagerList").innerHTML = sections.map(([key, projects]) => {
    const title = mode === "month"
      ? monthGroupLabel(key)
      : mode === "custom"
        ? (draft.groups.find((group) => group.id === key)?.name || "未分组")
        : "全部项目";
    return `<section class="manager-group-section"><div class="manager-group-head"><strong>${escapeHtml(title)}</strong><span>${projects.length} 个项目</span></div>${projects.map((project) => managerProjectRow(project, mode === "custom")).join("")}</section>`;
  }).join("");
  $("#projectManagerEmpty").classList.toggle("hidden", draft.projects.length > 0);
}
function openNewProjectDialog() {
  $("#newProjectForm").reset();
  state.projectManagerDraft = copyProjectManagerDraft();
  renderProjectManager();
  $("#newProjectDialog").showModal();
  setTimeout(() => $("#newProjectName").focus(), 0);
}

function closeNewProjectDialog() {
  state.projectManagerDraft = null;
  $("#newProjectDialog").close();
}

$("#chooseLibrary").addEventListener("click", chooseLibrary);
$("#changeLibrary").addEventListener("click", async () => { await chooseLibrary(); populateSettings(); });
$("#pickFiles").addEventListener("click", async () => importPaths(await window.worktrace.chooseFiles(), activeProjectId()));
$("#openHelp").addEventListener("click", () => $("#helpDialog").showModal());
$("#closeHelp").addEventListener("click", () => $("#helpDialog").close());
[$("#visitHelpSite"), $("#visitContactSite")].forEach((button) => button.addEventListener("click", async () => {
  try {
    await window.worktrace.openExternal("https://shansha.xyz/");
  } catch (error) {
    toast(error.message, true);
  }
}));
function closeNewFileDialog() {
  $("#newFileDialog").close();
}

async function openNewFileDialog() {
  if (!await ensureReady()) return;
  if (!state.settings?.libraryPath) {
    toast("请先选择工作资料库", true);
    return;
  }
  $("#newFileForm").reset();
  $("#newFileDialog").showModal();
  setTimeout(() => $("#newFileTitle").focus(), 0);
}

$("#openNewFile").addEventListener("click", openNewFileDialog);
$("#closeNewFile").addEventListener("click", closeNewFileDialog);
$("#cancelNewFile").addEventListener("click", closeNewFileDialog);
$("#newFileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#createNewFile");
  button.disabled = true;
  try {
    const record = await window.worktrace.createOfficeFile({
      type: $("#newFileType").value,
      title: $("#newFileTitle").value.trim(),
      projectId: activeProjectId(),
    });
    state.records.unshift(record);
    closeNewFileDialog();
    render();
    toast("文件已创建，正在打开");
    try {
      await window.worktrace.openFile(record.storedPath);
    } catch (openError) {
      toast(`文件已创建，但没有自动打开：${openError.message}`, true);
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#openSettings").addEventListener("click", async () => {
  if (!await ensureReady()) return;
  populateSettings();
  $("#settingsDialog").showModal();
});
$("#noticeStack").addEventListener("click", (event) => {
  if (!event.target.closest("[data-dismiss-notice]")) return;
  $("#noticeStack").classList.add("hidden");
  $("#noticeStack").innerHTML = "";
});
$("#exportBackup").addEventListener("click", async () => {
  const status = $("#backupStatus");
  status.textContent = "正在整理备份…";
  try {
    const result = await window.worktrace.exportBackup();
    if (!result) {
      status.textContent = "已取消导出。";
      return;
    }
    status.textContent = `已导出 ${result.recordCount} 条记录和 ${result.taskCount} 个任务。`;
    toast("工作台备份已导出");
  } catch (error) {
    status.textContent = `导出失败：${error.message}`;
    toast(error.message, true);
  }
});
$("#importBackup").addEventListener("click", async () => {
  const status = $("#backupStatus");
  status.textContent = "请选择备份文件…";
  try {
    const result = await window.worktrace.importBackup();
    if (!result) {
      status.textContent = "已取消恢复。";
      return;
    }
    state.settings = result.settings;
    [state.records, state.manualTasks] = await Promise.all([window.worktrace.listRecords(), window.worktrace.listTasks()]);
    populateSettings();
    render();
    status.textContent = `已恢复 ${result.recordCount} 条记录和 ${result.taskCount} 个任务。`;
    toast("工作台数据已恢复");
  } catch (error) {
    status.textContent = `恢复失败：${error.message}`;
    toast(error.message, true);
  }
});
$("#openAssistant").addEventListener("click", async () => {
  if (!await ensureReady()) return;
  refreshAssistantEntry();
  if (!assistantReady()) { toast("请先在设置里开启 AI 并保存有效的 API 配置", true); return; }
  showAssistant();
});
$("#closeAssistant").addEventListener("click", hideAssistant);
$("#assistantForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#assistantText");
  const text = input.value;
  input.value = "";
  await askAssistant(text);
});
$("#assistantSuggest").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-assistant-suggestion]");
  if (button) await askAssistant(button.dataset.assistantSuggestion);
});
$("#assistantContext").addEventListener("click", (event) => {
  const record = event.target.closest("[data-remove-assistant-record]");
  if (record) {
    state.assistantRecordIds.delete(record.dataset.removeAssistantRecord);
    renderAssistant();
    render();
    return;
  }
  const project = event.target.closest("[data-remove-assistant-project]");
  if (project) {
    state.assistantProjectIds.delete(project.dataset.removeAssistantProject);
    renderAssistant();
    render();
    return;
  }
  if (event.target.closest("[data-clear-assistant-context]")) {
    state.assistantRecordIds.clear();
    state.assistantProjectIds.clear();
    renderAssistant();
    render();
  }
});
/** 跳转前记住当前位置，跳完给一个"返回"按钮。 */
let jumpReturnState = null;

function rememberBeforeJump() {
  jumpReturnState = {
    view: state.view,
    timelineMode: state.timelineMode,
    projectFilter: state.projectFilter,
    projectPage: state.projectPage,
    projectContentView: state.projectContentView,
    fileQuery: state.fileQuery,
    recordDateFilter: state.recordDateFilter,
    taskStatus: state.taskStatus,
  };
}

function showJumpReturn() {
  let bar = document.getElementById("jumpReturn");
  if (!bar) {
    bar = document.createElement("button");
    bar.id = "jumpReturn";
    bar.type = "button";
    bar.style.cssText = "position:fixed;left:18px;bottom:18px;z-index:9999;padding:8px 14px;border:1px solid #3a2b24;border-radius:999px;background:#fff;color:#3a2b24;font-size:12px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.18)";
    document.body.appendChild(bar);
  }
  bar.textContent = "← 返回刚才的位置";
  bar.style.display = "block";
  clearTimeout(showJumpReturn.timer);
  showJumpReturn.timer = setTimeout(() => { bar.style.display = "none"; }, 25000);
  bar.onclick = () => {
    bar.style.display = "none";
    const saved = jumpReturnState;
    if (!saved) return;
    state.view = saved.view;
    state.timelineMode = saved.timelineMode;
    state.projectFilter = saved.projectFilter;
    state.projectPage = saved.projectPage;
    state.projectContentView = saved.projectContentView;
    state.fileQuery = saved.fileQuery;
    state.recordDateFilter = saved.recordDateFilter;
    state.taskStatus = saved.taskStatus;
    render();
    toast("已回到刚才的位置");
  };
}

/** 清掉可能把目标藏起来的筛选条件。 */
function clearHidingFilters() {
  state.fileQuery = "";
  state.recordDateFilter = "";
  state.taskStatus = "all";
  if (state.projectFilter && state.projectFilter !== "__all__") state.projectFilter = "__all__";
}

async function executeAssistantAction(action) {
  if (!action?.input) throw new Error("操作方案不完整");
  if (action.type === "create_task") {
    const projectId = action.input.projectId || "";
    if (projectId && !state.settings?.projects?.some((item) => item.id === projectId)) throw new Error("方案中的项目已不存在");
    const recordIds = Array.isArray(action.input.recordIds) ? action.input.recordIds : [];
    if (recordIds.some((id) => !state.records.some((record) => record.id === id))) throw new Error("方案中有文件已不存在");
    return window.worktrace.createTask(action.input);
  }
  if (action.type === "update_task") {
    const { taskId, sourceKind, recordId, changes = {} } = action.input;
    if (Array.isArray(changes.recordIds) && changes.recordIds.some((id) => !state.records.some((record) => record.id === id))) {
      throw new Error("方案中有关联文件已不存在");
    }
    if (sourceKind === "record") {
      const record = state.records.find((item) => item.id === recordId);
      if (!record) throw new Error("没有找到任务的来源文件");
      const taskItems = taskItemsFor(record).map((item) => item.id === taskId ? { ...item, ...changes } : { ...item });
      if (!taskItems.some((item) => item.id === taskId)) throw new Error("没有找到这条任务");
      return window.worktrace.updateRecord({ id: recordId, taskItems });
    }
    return window.worktrace.updateTask({ id: taskId, ...changes });
  }
  if (action.type === "create_project") {
    return window.worktrace.createProject(action.input);
  }
  if (action.type === "update_record") {
    return window.worktrace.updateRecord({ id: action.input.recordId, ...action.input.changes });
  }
  if (action.type === "create_office_file") {
    const input = { ...action.input };
    let targetTask = null;
    let taskSourceRecord = null;
    if (input.taskId) {
      if (input.taskSourceKind === "record") {
        taskSourceRecord = state.records.find((record) => record.id === input.taskRecordId);
        if (!taskSourceRecord) throw new Error("没有找到任务的来源文件");
        targetTask = taskItemsFor(taskSourceRecord).find((task) => task.id === input.taskId);
      } else {
        targetTask = state.manualTasks.find((task) => task.id === input.taskId);
      }
      if (!targetTask) throw new Error("要关联的任务已不存在");
      if (!input.projectId && targetTask.projectId) input.projectId = targetTask.projectId;
    }
    if (input.sourceRecordId && !state.records.some((record) => record.id === input.sourceRecordId)) {
      throw new Error("要生成副本的原文件已不存在");
    }
    const created = await window.worktrace.createOfficeFile(input);
    if (targetTask) {
      const recordIds = [...new Set([...(targetTask.recordIds || []), created.id])];
      if (input.taskSourceKind === "record") {
        const taskItems = taskItemsFor(taskSourceRecord).map((task) => task.id === input.taskId ? { ...task, recordIds } : task);
        await window.worktrace.updateRecord({ id: taskSourceRecord.id, taskItems });
      } else {
        await window.worktrace.updateTask({ id: targetTask.id, recordIds });
      }
    }
    return created;
  }
  throw new Error("这项操作暂不支持执行");
}

async function confirmAssistantAction(messageIndex, actionId) {
  const message = state.assistantHistory[messageIndex];
  const action = message?.actions?.find((item) => item.id === actionId);
  if (!action || action.status !== "pending") return;
  action.status = "executing";
  action.error = "";
  renderAssistant();
  try {
    await executeAssistantAction(action);
    action.status = "done";
    await refresh();
    renderAssistant();
    toast("操作已执行，工作台已同步");
  } catch (error) {
    action.status = "error";
    action.error = error?.message || String(error) || "执行失败";
    renderAssistant();
  }
}

function cancelAssistantAction(messageIndex, actionId) {
  const message = state.assistantHistory[messageIndex];
  const action = message?.actions?.find((item) => item.id === actionId);
  if (!action || action.status !== "pending") return;
  action.status = "cancelled";
  renderAssistant();
}

$("#assistantLog").addEventListener("click", async (event) => {
  const execute = event.target.closest("[data-assistant-execute]");
  if (execute) {
    await confirmAssistantAction(Number(execute.dataset.assistantExecute), execute.dataset.assistantAction);
    return;
  }
  const cancel = event.target.closest("[data-assistant-cancel]");
  if (cancel) {
    cancelAssistantAction(Number(cancel.dataset.assistantCancel), cancel.dataset.assistantAction);
    return;
  }
  const jump = event.target.closest("[data-assistant-jump]");
  const cite = event.target.closest("[data-assistant-cite]");
  const kind = jump ? jump.dataset.assistantJump : (cite ? "record" : "");
  const id = jump ? jump.dataset.assistantTarget : (cite ? cite.dataset.assistantCite : "");
  if (!kind || !id) return;
  rememberBeforeJump();
  hideAssistant();
  clearHidingFilters();
  let where = "全部记录";
  if (kind === "project") {
    const project = (state.settings?.projects || []).find((item) => item.id === id);
    where = "项目记录";
    state.view = "timeline";
    state.timelineMode = "project";
    state.projectFilter = id;
    state.projectPage = "timeline";
    state.projectContentView = "files";
    render();
    if (typeof loadProjectOverview === "function") loadProjectOverview(id);
    document.querySelector(`[data-project-context="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    toast("已跳到「" + (project ? project.name : "该项目") + "」的项目记录");
    showJumpReturn();
    return;
  }
  if (kind === "task") {
    where = "任务列表";
    state.view = "timeline";
    state.timelineMode = "tasks";
    render();
    const row = document.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (row) { row.classList.add("mention-hit"); setTimeout(() => row.classList.remove("mention-hit"), 2400); }
    toast("已跳到「任务列表」，目标已高亮");
    showJumpReturn();
    return;
  }
  state.view = "timeline";
  state.timelineMode = "chronological";
  state.expandedRecords.add(id);
  render();
  document.querySelector(`[data-record-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  toast("已跳到「" + where + "」，目标已展开");
  showJumpReturn();
});
$("#openNewProject").addEventListener("click", async () => {
  if (!await ensureReady()) return;
  openNewProjectDialog();
});
$("#closeNewProject").addEventListener("click", closeNewProjectDialog);
$("#cancelNewProject").addEventListener("click", closeNewProjectDialog);
$("#createProject").addEventListener("click", () => {
  const name = $("#newProjectName").value.trim();
  if (!name) {
    toast("请填写项目名称", true);
    return;
  }
  syncProjectManagerDraftFromDom();
  const projects = state.projectManagerDraft.projects;
  if (projects.some((project) => project.name.trim().toLowerCase() === name.toLowerCase())) {
    toast("已经有同名项目了", true);
    return;
  }
  projects.push({
    id: `project-${Date.now()}`,
    name,
    owner: $("#newProjectOwner").value.trim(),
    aliases: $("#newProjectAliases").value.trim(),
    groupId: "",
    createdAt: new Date().toISOString(),
  });
  renderProjectManager();
  $("#newProjectName").value = "";
  $("#newProjectOwner").value = "";
  $("#newProjectAliases").value = "";
  $("#newProjectName").focus();
});
$("#projectManagerList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-manager-project]");
  if (!row) return;
  const remove = event.target.closest("[data-manager-remove]");
  if (remove) {
    syncProjectManagerDraftFromDom();
    state.projectManagerDraft.projects = state.projectManagerDraft.projects.filter((project) => project.id !== row.dataset.id);
    renderProjectManager();
    return;
  }
  const open = event.target.closest("[data-manager-open]");
  const isBlankCardClick = event.target === row;
  if (!open && !isBlankCardClick) return;
  saveProjectManagerChanges(row.dataset.id);
});

$("#projectManagerList").addEventListener("change", (event) => {
  const select = event.target.closest("[data-manager-group-select]");
  if (!select) return;
  syncProjectManagerDraftFromDom();
});

$("#projectGroupingMode").addEventListener("change", (event) => {
  syncProjectManagerDraftFromDom();
  state.projectManagerDraft.mode = event.target.value;
  renderProjectManager();
});

$("#addProjectGroup").addEventListener("click", () => {
  const input = $("#newProjectGroupName");
  const name = input.value.trim();
  if (!name) {
    toast("请先输入分组名称", true);
    return;
  }
  syncProjectManagerDraftFromDom();
  if (state.projectManagerDraft.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
    toast("已经有同名分组了", true);
    return;
  }
  state.projectManagerDraft.groups.push({ id: `group-${Date.now()}`, name });
  input.value = "";
  renderProjectManager();
});

$("#managerGroupList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-manager-group-remove]");
  if (!button) return;
  syncProjectManagerDraftFromDom();
  const groupId = button.dataset.managerGroupRemove;
  state.projectManagerDraft.groups = state.projectManagerDraft.groups.filter((group) => group.id !== groupId);
  state.projectManagerDraft.projects = state.projectManagerDraft.projects.map((project) => project.groupId === groupId ? { ...project, groupId: "" } : project);
  renderProjectManager();
});

async function saveProjectManagerChanges(openProjectId = "") {
  const button = $("#saveProjectManager");
  button.disabled = true;
  try {
    syncProjectManagerDraftFromDom();
    const { mode, groups, projects } = state.projectManagerDraft;
    if (projects.some((project) => !project.name.trim())) throw new Error("项目名称不能为空");
    state.settings = await window.worktrace.saveProjects(projects);
    state.settings = await window.worktrace.saveProjectLayout({
      mode,
      groups,
      assignments: Object.fromEntries(projects.map((project) => [project.id, project.groupId || ""])),
    });
    [state.records, state.manualTasks] = await Promise.all([window.worktrace.listRecords(), window.worktrace.listTasks()]);
    closeNewProjectDialog();
    if (openProjectId && state.settings.projects.some((project) => project.id === openProjectId)) {
      state.view = "timeline";
      state.timelineMode = "project";
      state.projectFilter = openProjectId;
      state.projectPage = "overview";
      state.projectContentView = "tasks";
    }
    render();
    if (openProjectId) loadProjectOverview(openProjectId);
    toast(openProjectId ? "项目已保存并打开" : "项目修改已保存");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

$("#newProjectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveProjectManagerChanges();
});
$("#timelineDateInput").addEventListener("change", (event) => {
  state.recordDateFilter = event.target.value;
  render();
  $("#records").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#clearTimelineDate").addEventListener("click", () => {
  state.recordDateFilter = "";
  render();
});

$$('.nav-item[data-view]').forEach((button) => button.addEventListener("click", async () => {
  if (!await ensureReady()) return;
  if (button.dataset.view === "tasks") {
    state.view = "timeline";
    state.timelineMode = "tasks";
    state.modeTouched = true;
    state.projectPage = "timeline";
    state.projectFilter = "__all__";
    render();
    return;
  }
  state.view = button.dataset.view;
  if (state.view === "timeline") {
    state.timelineMode = "project";
    state.projectPage = "timeline";
    // 回到"全部项目"，否则会一直停在上次打开的那个项目里出不来
    state.projectFilter = "__all__";
  }
  render();
}));

$("#taskComposer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#createTask");
  button.disabled = true;
  try {
    const task = await window.worktrace.createTask({
      text: $("#newTaskText").value,
      dueDate: $("#newTaskDueDate").value,
    });
    state.manualTasks.unshift(task);
    $("#taskComposer").reset();
    render();
    toast("任务已添加");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#createProjectFromTasks").addEventListener("click", openTaskProjectCreateDialog);
$("#closeTaskProjectCreate").addEventListener("click", closeTaskProjectCreateDialog);
$("#cancelTaskProjectCreate").addEventListener("click", closeTaskProjectCreateDialog);
$("#taskProjectName").addEventListener("input", renderTaskProjectCreateList);
$("#taskProjectCreateList").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-task-project-create]");
  if (!checkbox) return;
  if (checkbox.checked) state.taskProjectCreateSelection.add(checkbox.dataset.taskProjectCreate);
  else state.taskProjectCreateSelection.delete(checkbox.dataset.taskProjectCreate);
  renderTaskProjectCreateList();
});
$("#taskProjectCreateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#taskProjectName").value.trim();
  const selectedTasks = unassignedTasks().filter((task) => state.taskProjectCreateSelection.has(taskKey(task)));
  if (!name || !selectedTasks.length) return;
  const button = $("#confirmTaskProjectCreate");
  button.disabled = true;
  try {
    const result = await window.worktrace.createProject({ name });
    state.settings = result.settings;
    await assignTasksToProject(selectedTasks, result.project.id);
    closeTaskProjectCreateDialog();
    state.view = "timeline";
    state.timelineMode = "project";
    state.projectFilter = result.project.id;
    state.projectPage = "overview";
    state.projectContentView = "tasks";
    render();
    loadProjectOverview(result.project.id);
    toast(`已用 ${selectedTasks.length} 个任务建立项目`);
  } catch (error) {
    toast(error.message, true);
    await refresh().catch(() => {});
    renderTaskProjectCreateList();
  } finally {
    if (button.isConnected) button.disabled = !$("#taskProjectName")?.value.trim() || state.taskProjectCreateSelection.size === 0;
  }
});

$("#taskStatusFilter").addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-status]");
  if (!button) return;
  state.taskStatus = button.dataset.taskStatus;
  render();
});


async function updatePageTask(row, changes, successMessage) {
  if (row.dataset.taskKind === "record") {
    const recordChanges = Object.hasOwn(changes, "projectId") ? { ...changes, projectIdExplicit: true } : changes;
    await changeProjectTask(row.dataset.recordId, row.dataset.taskId, recordChanges, successMessage);
    return;
  }
  try {
    const updated = await window.worktrace.updateTask({ id: row.dataset.taskId, ...changes });
    const index = state.manualTasks.findIndex((item) => item.id === updated.id);
    if (index >= 0) state.manualTasks[index] = updated;
    render();
    if (successMessage) toast(successMessage);
  } catch (error) {
    toast(error.message, true);
    render();
  }
}

$("#taskPageList").addEventListener("change", async (event) => {
  const row = event.target.closest("[data-task-kind]");
  if (!row) return;
  if (event.target.matches("[data-page-task-toggle]")) {
    await updatePageTask(row, { completed: event.target.checked }, "任务状态已更新");
  } else if (event.target.matches("[data-page-task-text]")) {
    await updatePageTask(row, { text: event.target.value.trim() }, "任务内容已更新");
  } else if (event.target.matches("[data-page-task-due]")) {
    await updatePageTask(row, { dueDate: event.target.value }, "截止日期已更新");
  }
});

$("#taskPageList").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-task-kind]");
  if (!row) return;
  if (event.target.closest("[data-edit-task-project]")) {
    openProjectPicker({
      kind: "task",
      sourceKind: row.dataset.taskKind,
      id: row.dataset.taskId,
      recordId: row.dataset.recordId,
    });
    return;
  }
  if (event.target.closest("[data-toggle-task-files]")) {
    const key = row.dataset.taskKey;
    if (state.expandedTaskKeys.has(key)) state.expandedTaskKeys.delete(key);
    else state.expandedTaskKeys.add(key);
    render();
    return;
  }
  if (event.target.closest("[data-edit-task-files]")) {
    const task = taskFromTarget({ sourceKind: row.dataset.taskKind, id: row.dataset.taskId, recordId: row.dataset.recordId });
    if (task) openTaskLinkDialog(task);
    return;
  }
  const createFileButton = event.target.closest("[data-create-task-file]");
  if (createFileButton) {
    const task = taskFromTarget({ sourceKind: row.dataset.taskKind, id: row.dataset.taskId, recordId: row.dataset.recordId });
    await createAndLinkOfficeFile(task, createFileButton.dataset.createTaskFile, createFileButton);
    return;
  }
  const linkedFile = event.target.closest("[data-open-linked-file]");
  if (linkedFile) {
    if (assistantOpen()) toggleAssistantRecord(linkedFile.dataset.linkedRecordId);
    else if (linkedFile.dataset.openLinkedFile) {
      try { await window.worktrace.openFile(linkedFile.dataset.openLinkedFile); } catch (error) { toast(error.message, true); }
    }
    return;
  }
  const button = event.target.closest("[data-page-task-delete]");
  if (!button) return;
  if (row.dataset.taskKind === "record") {
    await changeProjectTask(row.dataset.recordId, row.dataset.taskId, { remove: true }, "任务已删除");
    return;
  }
  try {
    await window.worktrace.deleteTask(row.dataset.taskId);
    state.manualTasks = state.manualTasks.filter((item) => item.id !== row.dataset.taskId);
    render();
    toast("任务已删除");
  } catch (error) {
    toast(error.message, true);
  }
});

let draggedTaskRow = null;
let taskDropHandled = false;

function clearTaskDragStyles() {
  $$("#taskPageList .task-page-row").forEach((row) => row.classList.remove("dragging", "drag-over"));
}

function taskOrderFromRenderedList() {
  const counters = { "0": 0, "1": 0 };
  return $$("#taskPageList .task-page-row").map((row) => {
    const completed = row.dataset.taskCompleted === "1" ? "1" : "0";
    const sortOrder = counters[completed] * 100;
    counters[completed] += 1;
    return {
      sourceKind: row.dataset.taskKind,
      id: row.dataset.taskId,
      recordId: row.dataset.recordId,
      sortOrder,
    };
  });
}

async function saveRenderedTaskOrder(updates) {
  try {
    await window.worktrace.reorderTasks(updates);
    [state.records, state.manualTasks] = await Promise.all([window.worktrace.listRecords(), window.worktrace.listTasks()]);
    render();
    toast("任务优先级顺序已保存");
  } catch (error) {
    toast(error.message, true);
    await refresh().catch(() => {});
    render();
  }
}

$("#taskPageList").addEventListener("dragstart", (event) => {
  const handle = event.target.closest("[data-task-drag-handle]");
  if (!handle || state.taskQuery) {
    event.preventDefault();
    return;
  }
  draggedTaskRow = handle.closest(".task-page-row");
  if (!draggedTaskRow) return;
  taskDropHandled = false;
  draggedTaskRow.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedTaskRow.dataset.taskKey || "task");
});

$("#taskPageList").addEventListener("dragover", (event) => {
  if (!draggedTaskRow) return;
  const target = event.target.closest(".task-page-row");
  if (!target || target === draggedTaskRow || target.dataset.taskCompleted !== draggedTaskRow.dataset.taskCompleted) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  $$("#taskPageList .task-page-row.drag-over").forEach((row) => row.classList.remove("drag-over"));
  target.classList.add("drag-over");
  const beforeTarget = event.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
  target.parentElement.insertBefore(draggedTaskRow, beforeTarget ? target : target.nextSibling);
});

$("#taskPageList").addEventListener("drop", (event) => {
  if (!draggedTaskRow) return;
  const target = event.target.closest(".task-page-row");
  // 落在行与行之间的空隙也算数，只要不是拖到"已完成/未完成"另一组里
  if (target && target.dataset.taskCompleted !== draggedTaskRow.dataset.taskCompleted) return;
  event.preventDefault();
  taskDropHandled = true;
  const updates = taskOrderFromRenderedList();
  clearTaskDragStyles();
  saveRenderedTaskOrder(updates);
});

$("#taskPageList").addEventListener("dragend", () => {
  const moved = Boolean(draggedTaskRow) && !taskDropHandled;
  const updates = moved ? taskOrderFromRenderedList() : null;
  clearTaskDragStyles();
  draggedTaskRow = null;
  taskDropHandled = false;
  // 拖动确实挪动了行，就把当前顺序存下来；否则保持原样
  if (updates) saveRenderedTaskOrder(updates);
  else render();
});

$("#taskLinkSearch").addEventListener("input", renderTaskLinkList);
$("#projectPickerSearch").addEventListener("input", renderProjectPickerList);
$("#closeProjectPicker").addEventListener("click", closeProjectPicker);
$("#cancelProjectPicker").addEventListener("click", closeProjectPicker);

async function applyProjectPickerSelection(target, projectId) {
  if (target.kind === "filter") {
    state.projectFilter = projectId;
    // 正看着某个项目的概览时，切换项目就继续看新项目的概览
    const stayOverview = state.projectPage === "overview" && projectId && projectId !== "__all__" && projectId !== "__unassigned__";
    state.projectPage = stayOverview ? "overview" : "timeline";
    closeProjectPicker();
    render();
    if (stayOverview && typeof loadProjectOverview === "function") loadProjectOverview(projectId);
    return true;
  }
  if (target.kind === "batch") {
    const changed = await applyBatchProject(projectId);
    if (changed) closeProjectPicker();
    return changed;
  }
  if (target.kind === "record") {
    const updated = await window.worktrace.updateRecord({ id: target.recordId, projectId });
    const index = state.records.findIndex((record) => record.id === target.recordId);
    if (index >= 0) state.records[index] = { ...state.records[index], ...updated };
    closeProjectPicker();
    render();
    toast("所属项目已更新");
    return true;
  }
  if (target.kind === "task") {
    if (target.sourceKind === "record") {
      const record = state.records.find((item) => item.id === target.recordId);
      if (!record) throw new Error("没有找到任务的来源文件");
      const taskItems = taskItemsFor(record).map((task) => task.id === target.id
        ? { ...task, projectId, projectIdExplicit: true }
        : task);
      const updated = await window.worktrace.updateRecord({ id: target.recordId, taskItems });
      const index = state.records.findIndex((item) => item.id === target.recordId);
      if (index >= 0) state.records[index] = { ...state.records[index], ...updated };
    } else {
      const updated = await window.worktrace.updateTask({ id: target.id, projectId });
      const index = state.manualTasks.findIndex((task) => task.id === updated.id);
      if (index >= 0) state.manualTasks[index] = updated;
    }
    closeProjectPicker();
    render();
    toast(projectId ? "任务所属项目已更新" : "任务已设为无项目");
    return true;
  }
  return false;
}

$("#projectPickerList").addEventListener("click", async (event) => {
  const option = event.target.closest("[data-project-picker-value]");
  if (!option || !state.projectPickerTarget) return;
  const target = state.projectPickerTarget;
  option.disabled = true;
  try {
    await applyProjectPickerSelection(target, option.dataset.projectPickerValue);
  } catch (error) {
    toast(error.message, true);
    option.disabled = false;
  }
});

$("#createProjectFromPicker").addEventListener("click", async () => {
  const target = state.projectPickerTarget;
  const name = $("#projectPickerSearch").value.trim();
  if (!target || !name) {
    toast("请先输入新项目名称", true);
    $("#projectPickerSearch").focus();
    return;
  }
  const button = $("#createProjectFromPicker");
  button.disabled = true;
  try {
    const result = await window.worktrace.createProject({ name });
    state.settings = result.settings;
    await applyProjectPickerSelection(target, result.project.id);
    toast(`已新建并选中“${result.project.name}”`);
  } catch (error) {
    toast(error.message, true);
    renderProjectPickerList();
  }
});

function enableSelectorKeyboard(dialogSelector, optionSelector) {
  $(dialogSelector).addEventListener("keydown", (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const options = [...$(dialogSelector).querySelectorAll(optionSelector)].filter((item) => !item.disabled);
    if (!options.length) return;
    const current = options.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? (current + 1 + options.length) % options.length
      : (current <= 0 ? options.length - 1 : current - 1);
    event.preventDefault();
    options[next].focus();
  });
}

enableSelectorKeyboard("#projectPickerDialog", "[data-project-picker-value]");
enableSelectorKeyboard("#taskLinkDialog", ".task-link-choice input");
enableSelectorKeyboard("#projectTaskPickerDialog", ".project-task-choice input");
enableSelectorKeyboard("#taskProjectCreateDialog", ".project-task-choice input");
$("#taskLinkList").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-task-link-record]");
  if (!checkbox) return;
  if (checkbox.checked) state.taskLinkRecordIds.add(checkbox.dataset.taskLinkRecord);
  else state.taskLinkRecordIds.delete(checkbox.dataset.taskLinkRecord);
});
$("#closeTaskLink").addEventListener("click", closeTaskLinkDialog);
$("#cancelTaskLink").addEventListener("click", closeTaskLinkDialog);
$("#taskLinkForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = taskFromTarget(state.taskLinkTarget);
  if (!task) {
    closeTaskLinkDialog();
    return;
  }
  const button = $("#saveTaskLinks");
  button.disabled = true;
  try {
    const recordIds = [...state.taskLinkRecordIds];
    if (task.sourceKind === "record") {
      await changeProjectTask(task.recordId, task.id, { recordIds }, "关联文件已更新");
    } else {
      const updated = await window.worktrace.updateTask({ id: task.id, recordIds });
      const index = state.manualTasks.findIndex((item) => item.id === updated.id);
      if (index >= 0) state.manualTasks[index] = updated;
      render();
      toast("关联文件已更新");
    }
    closeTaskLinkDialog();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#recordTaskSearch").addEventListener("input", renderRecordTaskList);
$("#recordTaskList").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-record-task-key]");
  if (!checkbox) return;
  if (checkbox.checked) state.recordTaskSelection.add(checkbox.dataset.recordTaskKey);
  else state.recordTaskSelection.delete(checkbox.dataset.recordTaskKey);
  $("#saveRecordTasks").textContent = `保存关联（${state.recordTaskSelection.size}）`;
});
$("#closeRecordTask").addEventListener("click", closeRecordTaskDialog);
$("#cancelRecordTask").addEventListener("click", closeRecordTaskDialog);
$("#createRecordTask").addEventListener("click", async () => {
  const record = state.records.find((item) => item.id === state.recordTaskTargetId);
  const text = $("#recordTaskNewText").value.trim();
  const dueDate = $("#recordTaskNewDue").value;
  if (!record) return;
  if (!text) {
    toast("请先填写任务内容", true);
    $("#recordTaskNewText").focus();
    return;
  }
  const button = $("#createRecordTask");
  button.disabled = true;
  try {
    const task = await window.worktrace.createTask({
      text,
      dueDate,
      projectId: record.projectId || "",
      recordIds: [record.id],
    });
    state.manualTasks.unshift(task);
    state.recordTaskSelection.add(taskKey({ ...task, sourceKind: "manual" }));
    $("#recordTaskNewText").value = "";
    $("#recordTaskNewDue").value = "";
    renderRecordTaskList();
    render();
    toast("任务已新建，并与文件和项目同步关联");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#recordTaskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const record = state.records.find((item) => item.id === state.recordTaskTargetId);
  if (!record) {
    closeRecordTaskDialog();
    return;
  }
  const button = $("#saveRecordTasks");
  button.disabled = true;
  try {
    const tasks = allTasksForPage();
    let changed = 0;
    for (const task of tasks) {
      const key = taskKey(task);
      const currentlyLinked = linkedRecordIds(task).includes(record.id);
      const shouldLink = state.recordTaskSelection.has(key);
      const fixed = task.sourceKind === "record" && task.recordId === record.id;
      if (!fixed && currentlyLinked !== shouldLink) {
        await updateTaskRecordLink(taskByKey(key) || task, record, shouldLink);
        changed += 1;
      }
    }
    closeRecordTaskDialog();
    render();
    toast(changed ? `已同步更新 ${changed} 项任务关联` : "任务关联没有变化");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#projectTaskPickerSearch").addEventListener("input", renderProjectTaskPicker);
$("#projectTaskPickerList").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-project-task-pick]");
  if (!checkbox) return;
  if (checkbox.checked) state.projectTaskSelection.add(checkbox.dataset.projectTaskPick);
  else state.projectTaskSelection.delete(checkbox.dataset.projectTaskPick);
  $("#assignProjectTasks").disabled = state.projectTaskSelection.size === 0;
});
$("#closeProjectTaskPicker").addEventListener("click", closeProjectTaskPicker);
$("#cancelProjectTaskPicker").addEventListener("click", closeProjectTaskPicker);
$("#projectTaskPickerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const projectId = state.projectTaskPickerProjectId;
  const selectedTasks = unassignedTasks().filter((task) => state.projectTaskSelection.has(taskKey(task)));
  if (!projectId || !selectedTasks.length) return;
  const button = $("#assignProjectTasks");
  button.disabled = true;
  try {
    await assignTasksToProject(selectedTasks, projectId);
    closeProjectTaskPicker();
    render();
    toast(`已将 ${selectedTasks.length} 个任务加入当前项目`);
  } catch (error) {
    toast(error.message, true);
    [state.records, state.manualTasks] = await Promise.all([window.worktrace.listRecords(), window.worktrace.listTasks()]);
    renderProjectTaskPicker();
  } finally {
    if (button.isConnected) button.disabled = state.projectTaskSelection.size === 0;
  }
});

$("#filters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  render();
});

$("#fileSearchInput").addEventListener("input", (event) => {
  state.fileQuery = event.target.value;
  render();
});

$("#taskSearchInput").addEventListener("input", (event) => {
  state.taskQuery = event.target.value;
  renderTaskPage();
});

$("#timelineToolbar").addEventListener("click", (event) => {
  state.modeTouched = true;
  const modeButton = event.target.closest("button[data-timeline-mode]");
  if (modeButton) {
    const previousMode = state.timelineMode;
    state.timelineMode = modeButton.dataset.timelineMode;
    if (state.timelineMode === "project" && previousMode !== "project") state.projectFilter = "__all__";
    if (state.timelineMode !== "project") state.projectPage = "timeline";
    render();
    return;
  }
  const pageButton = event.target.closest("button[data-project-page]");
  if (!pageButton) return;
  state.projectPage = pageButton.dataset.projectPage;
  if (state.projectPage === "timeline") state.projectFilter = "__all__";
  render();
  if (state.projectPage === "overview") loadProjectOverview(state.projectFilter);
});

$("#openProjectFilter").addEventListener("click", () => openProjectPicker({ kind: "filter" }));
$("#openFullTimeline").addEventListener("click", () => {
  state.view = "timeline";
  state.timelineMode = "chronological";
  state.recordDateFilter = "";
  state.fileQuery = "";
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

async function changeProjectTask(recordId, taskId, changes, successMessage) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  const tasks = taskItemsFor(record).map((item) => ({ ...item }));
  const index = tasks.findIndex((item) => item.id === taskId);
  if (index < 0) return;
  if (changes.remove) {
    tasks.splice(index, 1);
  } else {
    tasks[index] = { ...tasks[index], ...changes };
    if (!String(tasks[index].text || "").trim()) {
      toast("待办内容不能为空", true);
      render();
      return;
    }
  }
  await updateRecord(recordId, { taskItems: tasks }, successMessage);
}

$("#projectDetail").addEventListener("click", async (event) => {
  const revealProjectFile = event.target.closest("[data-reveal-project-file]");
  if (revealProjectFile) {
    if (revealProjectFile.dataset.revealProjectFile) window.worktrace.revealFile(revealProjectFile.dataset.revealProjectFile);
    return;
  }
  const linkRecordTasks = event.target.closest("[data-link-record-tasks]");
  if (linkRecordTasks) {
    openRecordTaskDialog(linkRecordTasks.dataset.linkRecordTasks);
    return;
  }
  const createRecordTask = event.target.closest("[data-create-record-task]");
  if (createRecordTask) {
    openRecordTaskDialog(createRecordTask.dataset.createRecordTask, true);
    return;
  }
  const contentView = event.target.closest("[data-project-content]");
  if (contentView) {
    state.projectContentView = contentView.dataset.projectContent;
    render();
    return;
  }
  if (event.target.closest("[data-add-project-files]")) {
    const paths = await window.worktrace.chooseFiles();
    await importPaths(paths, state.projectFilter);
    return;
  }
  if (event.target.closest("[data-new-project-file]")) {
    await openNewFileDialog();
    return;
  }
  const projectTaskRow = event.target.closest("[data-project-task-kind]");
  if (projectTaskRow && event.target.closest("[data-toggle-project-task-files]")) {
    const key = projectTaskRow.dataset.projectTaskKey;
    if (state.expandedTaskKeys.has(key)) state.expandedTaskKeys.delete(key);
    else state.expandedTaskKeys.add(key);
    render();
    return;
  }
  if (projectTaskRow && event.target.closest("[data-edit-project-task-files]")) {
    const task = taskFromTarget({
      sourceKind: projectTaskRow.dataset.projectTaskKind,
      id: projectTaskRow.dataset.projectTaskId,
      recordId: projectTaskRow.dataset.projectRecordId,
    });
    if (task) openTaskLinkDialog(task);
    return;
  }
  const linkedFile = event.target.closest("[data-open-linked-file]");
  if (linkedFile) {
    if (assistantOpen()) toggleAssistantRecord(linkedFile.dataset.linkedRecordId);
    else if (linkedFile.dataset.openLinkedFile) {
      try { await window.worktrace.openFile(linkedFile.dataset.openLinkedFile); } catch (error) { toast(error.message, true); }
    }
    return;
  }
  const projectFile = event.target.closest("[data-open-project-file]");
  if (projectFile) {
    if (assistantOpen()) toggleAssistantRecord(projectFile.dataset.projectFileId);
    else if (projectFile.dataset.openProjectFile) {
      try { await window.worktrace.openFile(projectFile.dataset.openProjectFile); } catch (error) { toast(error.message, true); }
    }
    return;
  }
  const contextProject = event.target.closest("[data-project-context]");
  if (contextProject && assistantOpen()) {
    toggleAssistantProject(contextProject.dataset.projectContext);
    return;
  }
  const generate = event.target.closest("[data-generate-overview]");
  if (generate) {
    const projectId = state.projectFilter;
    state.overviewBusy = projectId;
    render();
    try {
      state.projectOverviews[projectId] = await window.worktrace.generateProjectOverview(projectId);
      toast("项目概览已生成");
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.overviewBusy = "";
      render();
    }
    return;
  }
  if (event.target.closest("[data-open-ai-settings]")) {
    populateSettings();
    $("#settingsDialog").showModal();
    return;
  }
  const remove = event.target.closest("[data-task-delete]");
  if (remove) {
    await changeProjectTask(remove.dataset.recordId, remove.dataset.taskId, { remove: true }, "待办已删除");
    return;
  }
  if (event.target.closest("[data-add-manual-task]")) {
    try {
      const task = await window.worktrace.createTask({ text: "新待办", projectId: state.projectFilter });
      state.manualTasks.unshift(task);
      render();
      toast("已添加待办，可以直接修改文字");
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  if (event.target.closest("[data-add-existing-task]")) {
    openProjectTaskPicker(state.projectFilter);
    return;
  }
  const removeManual = event.target.closest("[data-manual-task-delete]");
  if (removeManual) {
    await removeManualTask(removeManual.dataset.taskId);
    return;
  }
  if (event.target.closest("[data-add-project-task]")) {
    const record = state.records.find((item) => item.projectId === state.projectFilter);
    if (!record) return;
    const tasks = [...taskItemsFor(record), { id: `${record.id}-task-${Date.now()}`, text: "新待办", completed: false }];
    await updateRecord(record.id, { taskItems: tasks }, "已添加待办，可以直接修改文字");
  }
});

$("#projectOverview").addEventListener("click", (event) => {
  const project = event.target.closest("[data-project-context]");
  if (project && assistantOpen()) toggleAssistantProject(project.dataset.projectContext);
});

$("#projectDetail").addEventListener("change", async (event) => {
  if (event.target.matches("[data-manual-task-toggle]")) {
    await updateManualTask(event.target.dataset.taskId, { completed: event.target.checked }, "待办状态已更新");
    return;
  }
  if (event.target.matches("[data-manual-task-text]")) {
    await updateManualTask(event.target.dataset.taskId, { text: event.target.value.trim() }, "待办内容已更新");
    return;
  }
  if (event.target.matches("[data-task-toggle]")) {
    await changeProjectTask(event.target.dataset.recordId, event.target.dataset.taskId, { completed: event.target.checked }, "待办状态已更新");
  }
  if (event.target.matches("[data-task-text]")) {
    await changeProjectTask(event.target.dataset.recordId, event.target.dataset.taskId, { text: event.target.value.trim() }, "待办内容已更新");
  }
});

$("#records").addEventListener("click", async (event) => {
  const linkRecordTasks = event.target.closest("[data-link-record-tasks]");
  if (linkRecordTasks) {
    openRecordTaskDialog(linkRecordTasks.dataset.linkRecordTasks);
    return;
  }
  const createRecordTask = event.target.closest("[data-create-record-task]");
  if (createRecordTask) {
    openRecordTaskDialog(createRecordTask.dataset.createRecordTask, true);
    return;
  }
  const contextProject = event.target.closest("[data-project-context]");
  if (contextProject && assistantOpen()) {
    toggleAssistantProject(contextProject.dataset.projectContext);
    return;
  }
  const toggle = event.target.closest("button[data-toggle-record]");
  if (toggle) {
    const id = toggle.dataset.toggleRecord;
    if (state.expandedRecords.has(id)) state.expandedRecords.delete(id);
    else state.expandedRecords.add(id);
    render();
    return;
  }
  const titleEl = event.target.closest("[data-edit-title]");
  if (titleEl) {
    if (assistantOpen()) {
      toggleAssistantRecord(titleEl.dataset.editTitle);
      return;
    }
    state.editingTitleId = titleEl.dataset.editTitle;
    render();
    return;
  }
  const card = event.target.closest("article.record");
  if (card && !event.target.closest("button,select,input,a,label,.record-inline-settings,.record-task-panel")) {
    const id = card.dataset.recordId;
    if (assistantOpen()) {
      toggleAssistantRecord(id);
      return;
    }
    if (id) {
      if (state.expandedRecords.has(id)) state.expandedRecords.delete(id);
      else state.expandedRecords.add(id);
      render();
      return;
    }
  }
  const pick = event.target.closest("button[data-pick-project], button[data-select-record-project]");
  if (pick) {
    const recordId = pick.dataset.pickProject || pick.dataset.selectRecordProject;
    if (assistantOpen()) {
      const record = state.records.find((item) => item.id === recordId);
      if (record?.projectId) toggleAssistantProject(record.projectId);
      else toggleAssistantRecord(record?.id);
      return;
    }
    openProjectPicker({ kind: "record", recordId });
    return;
  }
  const renameProject = event.target.closest("button[data-rename-project]");
  if (renameProject) {
    state.renamingProjectId = renameProject.dataset.renameProject;
    render();
    return;
  }
  const deleteProject = event.target.closest("button[data-delete-project]");
  if (deleteProject) {
    await deleteProjectInline(deleteProject.dataset.deleteProject);
    return;
  }
  const openProject = event.target.closest("button[data-open-project]");
  if (openProject) {
    if (assistantOpen()) {
      toggleAssistantProject(openProject.dataset.openProject);
      return;
    }
    state.projectFilter = openProject.dataset.openProject;
    state.projectPage = "overview";
    state.projectContentView = "tasks";
    render();
    loadProjectOverview(state.projectFilter);
    return;
  }
  const openFile = event.target.closest("button[data-open-file]");
  if (openFile) {
    try {
      await window.worktrace.openFile(openFile.dataset.openFile);
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  const refreshRecordButton = event.target.closest("button[data-refresh-record]");
  if (refreshRecordButton) {
    refreshRecordButton.disabled = true;
    try {
      const updated = await window.worktrace.refreshRecord(refreshRecordButton.dataset.refreshRecord);
      const index = state.records.findIndex((record) => record.id === updated.id);
      if (index >= 0) state.records[index] = { ...state.records[index], ...updated };
      render();
      if (updated.extractionError) toast(`文件已检查，但正文读取失败：${updated.extractionError}`, true);
      else toast("文件内容已重新读取，搜索索引已更新");
    } catch (error) {
      toast(error.message, true);
      if (refreshRecordButton.isConnected) refreshRecordButton.disabled = false;
    }
    return;
  }
  const reveal = event.target.closest("button[data-reveal]");
  if (reveal) window.worktrace.revealFile(reveal.dataset.reveal);
  const confirm = event.target.closest("button[data-confirm-project]");
  if (confirm) updateRecord(confirm.dataset.confirmProject, { projectId: confirm.dataset.projectId }, "项目已确认");
  const remove = event.target.closest("button[data-delete-record]");
  if (remove) {
    const record = state.records.find((item) => item.id === remove.dataset.deleteRecord);
    if (!record) return;
    state.pendingDeleteRecordId = record.id;
    $("#deleteRecordName").textContent = record.title || record.originalName || "未命名记录";
    $("#deleteRecordForm").reset();
    $("#deleteRecordDialog").showModal();
  }
});

function closeDeleteRecordDialog() {
  state.pendingDeleteRecordId = "";
  $("#deleteRecordDialog").close();
}

$("#closeDeleteRecord").addEventListener("click", closeDeleteRecordDialog);
$("#cancelDeleteRecord").addEventListener("click", closeDeleteRecordDialog);
$("#deleteRecordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = state.pendingDeleteRecordId;
  if (!id) return;
  const button = $("#confirmDeleteRecord");
  const trashOriginal = true;
  button.disabled = true;
  try {
    await window.worktrace.deleteRecord({ id, trashOriginal });
    state.records = state.records.filter((record) => record.id !== id);
    closeDeleteRecordDialog();
    render();
    toast(trashOriginal ? "记录已删除，原文件已移到废纸篓" : "记录已删除，原文件仍保留在资料库");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#records").addEventListener("keydown", (event) => {
  const input = event.target.closest("[data-title-input]");
  if (!input) return;
  if (event.key === "Enter") {
    event.preventDefault();
    input.blur();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    state.editingTitleId = "";
    render();
  }
});

$("#records").addEventListener("focusout", async (event) => {
  const input = event.target.closest("[data-title-input]");
  if (!input) return;
  const id = input.dataset.titleInput;
  const title = input.value.trim();
  const record = state.records.find((item) => item.id === id);
  state.editingTitleId = "";
  if (!record || !title || title === record.title) {
    render();
    return;
  }
  try {
    const updated = await window.worktrace.updateRecord({ id, title });
    const index = state.records.findIndex((item) => item.id === id);
    if (index >= 0) state.records[index] = { ...state.records[index], ...updated };
    render();
    toast("标题已更新");
  } catch (error) {
    toast(error.message, true);
    render();
  }
});

$("#records").addEventListener("change", (event) => {
  if (event.target.matches("[data-record-check]")) {
    const id = event.target.dataset.recordCheck;
    if (event.target.checked) state.batchSelection.add(id);
    else state.batchSelection.delete(id);
    $("#batchCount").textContent = `已选 ${state.batchSelection.size} 条`;
    return;
  }
  if (event.target.matches("[data-category-select]")) {
    updateRecord(event.target.dataset.categorySelect, { categoryId: event.target.value }, "文件已移入对应标签文件夹");
  }
  if (event.target.matches("[data-event-date]")) {
    updateRecord(event.target.dataset.eventDate, { eventDate: event.target.value }, "发生日期已更新");
  }
});

$("#provider").addEventListener("change", (event) => {
  syncProviderUi(event.target.value, false);
  state.aiTestPassed = false;
  setTestResult("新配置将在保存时自动检查", "neutral");
});

["#baseUrl", "#model", "#apiKey"].forEach((selector) => $(selector).addEventListener("input", () => {
  state.aiTestPassed = false;
  setTestResult("新配置将在保存时自动检查", "neutral");
}));

$("#aiEnabled").addEventListener("change", (event) => {
  $("#aiFields").style.opacity = event.target.checked ? "1" : ".55";
});

$("#visionEnabled").addEventListener("change", (event) => {
  $("#visionNotice").classList.toggle("hidden", !event.target.checked);
  state.aiTestPassed = false;
  setTestResult(event.target.checked ? "保存时会检查模型是否支持图片" : "保存时会重新检查连接", "neutral");
});

$("#categoriesEnabled").addEventListener("change", (event) => {
  $("#categoryList").classList.toggle("categories-disabled", !event.target.checked);
});

$("#addCategory").addEventListener("click", () => {
  const categories = readCategorySettings();
  categories.splice(Math.max(0, categories.length - 1), 0, { id: `category-${Date.now()}`, name: "新标签" });
  renderCategorySettings(categories);
});

$("#categoryList").addEventListener("click", (event) => {
  if (event.target.matches("[data-remove-category]")) {
    const row = event.target.closest("[data-category-row]");
    const name = row.querySelector("input").value.trim() || "这个标签";
    if (window.confirm(`删除“${name}”标签后，文件会安全移入“其他”文件夹。继续吗？`)) row.remove();
  }
});

$("#closeAiReady").addEventListener("click", () => $("#aiReadyDialog").close());

$("#saveSettings").addEventListener("click", async () => {
  const button = $("#saveSettings");
  const needsAiCheck = $("#aiEnabled").checked && !state.aiTestPassed;
  button.disabled = true;
  try {
    if (needsAiCheck) {
      button.textContent = "正在检查并保存…";
      setTestResult("正在检查 AI 连接，请稍候…", "checking");
      const result = await window.worktrace.testAi(formValue());
      state.aiTestPassed = true;
      setTestResult("连接成功，正在保存设置…", "success");
    }
    state.settings = await window.worktrace.saveSettings(formValue());
    [state.records, state.manualTasks] = await Promise.all([window.worktrace.listRecords(), window.worktrace.listTasks()]);
    $("#settingsDialog").close();
    render();
    if (needsAiCheck) $("#aiReadyDialog").showModal();
    toast(needsAiCheck ? "AI 已连接，设置已保存" : "设置已保存");
  } catch (error) {
    state.aiTestPassed = false;
    setTestResult(`没有保存这次配置：${error.message || "请检查下方设置"}`, "error");
    // Keep the dialog open and put the actionable message next to the fields;
    // a toast behind the modal is easy to miss.
  } finally {
    button.disabled = false;
    button.textContent = "保存设置";
  }
});

// ---------- 批量设置项目 ----------
function syncBatchBar() {
  const bar = $("#batchBar");
  if (!bar) return;
  bar.classList.toggle("hidden", !state.batchMode);
  if (!state.batchMode) return;
  $("#batchCount").textContent = `已选 ${state.batchSelection.size} 条`;
  $("#batchChooseProject").disabled = state.batchSelection.size === 0;
}

$("#toggleBatch").addEventListener("click", () => {
  state.batchMode = !state.batchMode;
  if (!state.batchMode) state.batchSelection.clear();
  render();
  syncBatchBar();
  toast(state.batchMode ? "已进入批量选择：勾选记录后统一设置项目" : "已退出批量选择");
});

$("#exitBatch").addEventListener("click", () => {
  state.batchMode = false;
  state.batchSelection.clear();
  render();
  syncBatchBar();
});

async function applyBatchProject(projectId) {
  if (!state.batchSelection.size) {
    toast("请先勾选要修改的记录", true);
    return false;
  }
  const project = state.settings.projects.find((item) => item.id === projectId);
  const ids = [...state.batchSelection];
  const button = $("#batchChooseProject");
  button.disabled = true;
  try {
    for (const id of ids) {
      await window.worktrace.updateRecord({ id, projectId });
    }
    state.records = await window.worktrace.listRecords();
    state.manualTasks = await window.worktrace.listTasks();
    state.batchSelection.clear();
    state.batchMode = false;
    render();
    syncBatchBar();
    toast(`已将 ${ids.length} 条记录设为「${project ? project.name : "无项目"}」`);
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  } finally {
    button.disabled = false;
  }
}

$("#batchChooseProject").addEventListener("click", () => {
  if (!state.batchSelection.size) {
    toast("请先勾选要修改的记录", true);
    return;
  }
  openProjectPicker({ kind: "batch" });
});

// ---------- 项目页：改名 / 删除 ----------
async function renameProjectInline(projectId, name) {
  const next = state.settings.projects.map((item) => (item.id === projectId ? { ...item, name } : item));
  try {
    state.settings = await window.worktrace.saveProjects(next);
    render();
    toast("项目已改名");
  } catch (error) {
    toast(error.message, true);
    render();
  }
}

async function deleteProjectInline(projectId) {
  const project = state.settings.projects.find((item) => item.id === projectId);
  if (!project) return;
  if (!window.confirm(`删除项目「${project.name}」？\n里面的记录不会被删除，只会变成“未归项目”。`)) return;
  try {
    state.settings = await window.worktrace.saveProjects(state.settings.projects.filter((item) => item.id !== projectId));
    [state.records, state.manualTasks] = await Promise.all([window.worktrace.listRecords(), window.worktrace.listTasks()]);
    if (state.projectFilter === projectId) state.projectFilter = "__all__";
    render();
    toast(`项目「${project.name}」已删除`);
  } catch (error) {
    toast(error.message, true);
  }
}

$("#records").addEventListener("keydown", (event) => {
  const input = event.target.closest("[data-rename-input]");
  if (!input) return;
  if (event.key === "Enter") {
    event.preventDefault();
    input.blur();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    state.renamingProjectId = "";
    render();
  }
});

$("#records").addEventListener("focusout", async (event) => {
  const input = event.target.closest("[data-rename-input]");
  if (!input) return;
  const projectId = input.dataset.renameInput;
  const name = input.value.trim();
  const project = state.settings.projects.find((item) => item.id === projectId);
  state.renamingProjectId = "";
  if (!project || !name || name === project.name) {
    render();
    return;
  }
  await renameProjectInline(projectId, name);
});

// ---------- 当前项目上下文 ----------
function activeProjectId() {
  if (!state.settings?.projects) return "";
  if (state.view !== "timeline" || state.timelineMode !== "project") return "";
  const id = state.projectFilter;
  if (!id || id === "__all__" || id === "__unassigned__") return "";
  return state.settings.projects.some((item) => item.id === id) ? id : "";
}

// ---------- 批量删除 ----------
async function deleteBatchSelected() {
  const ids = [...state.batchSelection];
  if (!ids.length) {
    toast("请先勾选要删除的记录", true);
    return;
  }
  if (!window.confirm(`删除选中的 ${ids.length} 条记录？\n原文件会移到系统废纸篓，需要时仍可恢复。`)) return;
  const button = $("#deleteBatchSelected");
  if (button) button.disabled = true;
  try {
    for (const id of ids) {
      await window.worktrace.deleteRecord({ id, trashOriginal: true });
    }
    state.records = await window.worktrace.listRecords();
    state.batchSelection.clear();
    state.batchMode = false;
    render();
    syncBatchBar();
    toast(`已删除 ${ids.length} 条记录，原文件已移到废纸篓`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

$("#deleteBatchSelected").addEventListener("click", deleteBatchSelected);

const dropZone = $("#dropZone");
["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
}));
dropZone.addEventListener("drop", (event) => {
  const paths = [...event.dataTransfer.files].map((file) => window.worktrace.pathForFile(file)).filter(Boolean);
  importPaths(paths, activeProjectId());
});

window.worktrace.onProgress((value) => {
  $("#progressWrap").classList.remove("hidden");
  $("#progressBar").style.width = `${Math.max(4, value.progress || 4)}%`;
  $("#progressText").textContent = value.message;
});

window.worktrace.onLibraryChanged(async (scan) => {
  await refresh();
  $("#progressBar").style.width = "100%";
  if (state.pendingImports === 0) setTimeout(() => $("#progressWrap").classList.add("hidden"), 1000);
  if (scan?.failed) toast(`${scan.failed} 个文件重新读取失败，请展开记录查看原因`, true);
  else if (scan?.added || scan?.updated) {
    const parts = [scan.added ? `新增 ${scan.added} 个文件` : "", scan.updated ? `更新 ${scan.updated} 个文件内容` : ""].filter(Boolean);
    toast(`工作文件夹已同步：${parts.join("，")}`);
  }
});

window.worktrace.onShowTasks?.(() => {
  state.view = "timeline";
  state.timelineMode = "tasks";
  state.modeTouched = true;
  state.projectPage = "timeline";
  render();
});

refresh().catch((error) => toast(error.message, true));
