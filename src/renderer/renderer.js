const state = {
  settings: null,
  records: [],
  manualTasks: [],
  filter: "全部",
  query: "",
  view: "today",
  timelineMode: "chronological",
  projectFilter: "",
  projectPage: "timeline",
  projectOverviews: {},
  overviewBusy: "",
  taskStatus: "open",
  taskProjectFilter: "",
  aiTestPassed: false,
  pendingDeleteRecordId: "",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = message;
  element.style.background = isError ? "#8a3e34" : "#282b26";
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3600);
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
  return "≡";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
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

function updateTextCaptureAvailability() {
  const ready = aiTextInputReady();
  document.querySelector(".text-capture").classList.toggle("hidden", !ready);
  $("#textCapture").disabled = !ready;
  $("#saveTextRecord").disabled = !ready;
  $("#textCaptureHint").textContent = ready
    ? "可单独保存，也可作为下一批图片或文件的补充说明"
    : "填写 API 密钥并开启 AI 后可用";
}

function renderProjectControl(record) {
  const options = state.settings.projects.map((project) =>
    `<option value="${escapeHtml(project.id)}"${selected(record.projectId, project.id)}>${escapeHtml(project.name)}</option>`,
  ).join("");
  const suggestion = aiTextInputReady() && !record.projectId && record.suggestedProjectName
    ? `<span class="project-suggestion">AI建议：${escapeHtml(record.suggestedProjectName)}${record.suggestedProjectId ? `<button data-confirm-project="${escapeHtml(record.id)}" data-project-id="${escapeHtml(record.suggestedProjectId)}">确认</button>` : "（可在设置中添加）"}</span>`
    : "";
  return `
    <select data-project-select="${escapeHtml(record.id)}" title="人工选择所属项目">
      <option value=""${selected(record.projectId, "")}>无项目</option>
      ${options}
    </select>
    ${suggestion}`;
}

function renderCategoryControl(record) {
  if (!state.settings.categoriesEnabled) return "";
  const currentId = categoryIdFor(record);
  const options = state.settings.categories.map((category) =>
    `<option value="${escapeHtml(category.id)}"${selected(currentId, category.id)}>${escapeHtml(category.name)}</option>`,
  ).join("");
  return `<select data-category-select="${escapeHtml(record.id)}" title="调整资料分类"><option value=""${selected(currentId, "")}>无分类</option>${options}</select>`;
}

function renderRecord(record) {
  const facts = [
    record.owners?.length ? `责任人：${record.owners.join("、")}` : "",
    record.tasks?.length ? `待办：${record.tasks.slice(0, 2).join("；")}` : "",
    record.decisions?.length ? `决定：${record.decisions.slice(0, 1).join("；")}` : "",
  ].filter(Boolean);
  return `
    <article class="record">
      <div class="record-icon">${iconFor(record)}</div>
      <div class="record-main">
        <div class="record-title">
          <strong>${escapeHtml(record.title)}</strong>
          ${state.settings.categoriesEnabled && record.category ? `<span class="category">${escapeHtml(record.category)}</span>` : ""}
          ${record.eventType ? `<span class="category">${escapeHtml(record.eventType)}</span>` : ""}
        </div>
        <div class="record-summary">${escapeHtml(record.summary || record.originalName)}</div>
        ${facts.length ? `<div class="record-facts">${escapeHtml(facts.join(" · "))}</div>` : ""}
        <div class="record-controls">
          ${renderProjectControl(record)}
          ${renderCategoryControl(record)}
          <input type="date" data-event-date="${escapeHtml(record.id)}" value="${escapeHtml(recordDay(record))}" title="事情实际发生的日期" />
        </div>
        ${record.extractionError ? `<div class="risk">正文读取提示：${escapeHtml(record.extractionError)}；原文件已正常保存</div>` : ""}
        ${record.riskNotes?.length ? `<div class="risk">△ ${escapeHtml(record.riskNotes.join(" · "))}${record.aiStatus === "skipped-sensitive" ? " · 已停止发送给云端 AI" : ""}</div>` : ""}
        ${record.aiStatus === "failed" ? `<div class="risk">AI 整理失败，已保留本地结果：${escapeHtml(record.aiError)}</div>` : ""}
      </div>
      <div class="record-meta">${formatDate(record)}<button data-reveal="${escapeHtml(record.storedPath)}">查看原件位置</button><button class="record-delete" data-delete-record="${escapeHtml(record.id)}">删除记录</button></div>
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
  const projects = state.settings.projects;
  if (state.projectFilter && state.projectFilter !== "__unassigned__" && !projects.some((item) => item.id === state.projectFilter)) {
    state.projectFilter = "";
  }
  if (!state.projectFilter && projects.length) state.projectFilter = projects[0].id;
  $("#projectFilter").innerHTML = [
    ...projects.map((project) => `<option value="${escapeHtml(project.id)}"${selected(state.projectFilter, project.id)}>${escapeHtml(project.name)}</option>`),
    `<option value="__unassigned__"${selected(state.projectFilter, "__unassigned__")}>未归属项目</option>`,
  ].join("");
}

function renderProjectOverview(records) {
  const element = $("#projectOverview");
  if (state.view !== "timeline" || state.timelineMode !== "project" || state.projectFilter === "__unassigned__") {
    element.classList.add("hidden");
    return;
  }
  const project = state.settings.projects.find((item) => item.id === state.projectFilter);
  if (!project) {
    element.classList.add("hidden");
    return;
  }
  const owners = [...new Set([project.owner, ...records.flatMap((record) => record.owners || [])].filter(Boolean))];
  const taskItems = [
    ...records.flatMap(taskItemsFor),
    ...state.manualTasks.filter((task) => task.projectId === project.id),
  ];
  const remainingTasks = taskItems.filter((item) => !item.completed).length;
  const completedTasks = taskItems.length - remainingTasks;
  const progress = taskItems.length ? Math.round((completedTasks / taskItems.length) * 100) : 0;
  const latest = records[0];
  element.innerHTML = `
    <div><h3>${escapeHtml(project.name)}</h3><p>${latest ? `最近进展：${escapeHtml(latest.summary || latest.title)}` : "还没有项目记录"}</p><div class="project-progress-track"><span style="width:${progress}%"></span></div></div>
    <div class="project-stat"><strong>${records.length}</strong><span>项目记录</span></div>
    <div class="project-stat"><strong>${taskItems.length ? `${progress}%` : "待确认"}</strong><span>${completedTasks}/${taskItems.length} 项待办已完成</span></div>
    <div class="project-stat"><strong>${escapeHtml(owners.join("、") || "待确认")}</strong><span>责任人</span></div>`;
  element.classList.remove("hidden");
}

function renderOverviewList(title, items, emptyText) {
  return `
    <div class="overview-list">
      <h4>${title}</h4>
      ${items?.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>${emptyText}</p>`}
    </div>`;
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
  const taskRows = records.flatMap((record) => taskItemsFor(record).map((task) => ({ ...task, record })));
  const completedCount = taskRows.filter((task) => task.completed).length;
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

    <div class="overview-card task-card">
      <div class="overview-card-head">
        <div><h3>项目待办</h3><p>${completedCount} 项已完成，${taskRows.length - completedCount} 项未完成</p></div>
        ${records.length ? `<button class="secondary compact" data-add-project-task>＋ 添加待办</button>` : ""}
      </div>
      <div class="project-task-list">
        ${taskRows.length ? taskRows.map((task) => `
          <div class="project-task-row${task.completed ? " completed" : ""}">
            <input type="checkbox" data-task-toggle data-record-id="${escapeHtml(task.record.id)}" data-task-id="${escapeHtml(task.id)}" ${task.completed ? "checked" : ""} aria-label="标记待办完成" />
            <div class="task-edit-wrap">
              <input data-task-text data-record-id="${escapeHtml(task.record.id)}" data-task-id="${escapeHtml(task.id)}" value="${escapeHtml(task.text)}" maxlength="300" aria-label="编辑待办" />
              <span>来自：${escapeHtml(task.record.title || task.record.originalName)}</span>
            </div>
            <button class="task-delete" data-task-delete data-record-id="${escapeHtml(task.record.id)}" data-task-id="${escapeHtml(task.id)}">删除</button>
          </div>`).join("") : `<div class="task-empty">还没有识别到待办。开启 AI 后新导入的资料会自动提取，也可以先手动添加。</div>`}
      </div>
    </div>`;
  element.classList.remove("hidden");
}

async function loadProjectOverview(projectId) {
  if (!projectId || projectId === "__unassigned__" || Object.hasOwn(state.projectOverviews, projectId)) return;
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
    ...state.settings.projects.map((project) =>
      `<option value="${escapeHtml(project.id)}"${selected(projectId, project.id)}>${escapeHtml(project.name)}</option>`,
    ),
  ].join("");
}

function allTasksForPage() {
  const manual = state.manualTasks.map((task) => ({ ...task, sourceKind: "manual", sourceLabel: "手工添加" }));
  const extracted = state.records.flatMap((record) => taskItemsFor(record).map((task) => ({
    ...task,
    sourceKind: "record",
    recordId: record.id,
    projectId: task.projectIdExplicit ? task.projectId : (record.projectId || ""),
    owner: task.owner || record.owners?.[0] || "",
    dueDate: task.dueDate || "",
    sourceLabel: `来自资料：${record.title || record.originalName}`,
  })));
  return [...manual, ...extracted];
}

function renderTaskPage() {
  const tasks = allTasksForPage();
  const today = dayKey(new Date().toISOString());
  const openCount = tasks.filter((task) => !task.completed).length;
  const completedCount = tasks.length - openCount;
  const dueSoon = tasks.filter((task) => !task.completed && task.dueDate && task.dueDate <= today).length;
  $("#taskStats").innerHTML = `
    <div><strong>${openCount}</strong><span>未完成</span></div>
    <div><strong>${dueSoon}</strong><span>今天到期或已逾期</span></div>
    <div><strong>${completedCount}</strong><span>已完成</span></div>
    <div><strong>${tasks.length}</strong><span>全部任务</span></div>`;

  $("#newTaskProject").innerHTML = taskProjectOptions($("#newTaskProject").value);
  $("#taskProjectFilter").innerHTML = [
    `<option value=""${selected(state.taskProjectFilter, "")}>全部项目</option>`,
    `<option value="__unassigned__"${selected(state.taskProjectFilter, "__unassigned__")}>无项目</option>`,
    ...state.settings.projects.map((project) =>
      `<option value="${escapeHtml(project.id)}"${selected(state.taskProjectFilter, project.id)}>${escapeHtml(project.name)}</option>`,
    ),
  ].join("");
  $$('[data-task-status]').forEach((button) => button.classList.toggle("active", button.dataset.taskStatus === state.taskStatus));

  const query = state.query.trim().toLowerCase();
  const visible = tasks.filter((task) => {
    const matchesStatus = state.taskStatus === "all"
      || (state.taskStatus === "completed" ? task.completed : !task.completed);
    const matchesProject = !state.taskProjectFilter
      || (state.taskProjectFilter === "__unassigned__" ? !task.projectId : task.projectId === state.taskProjectFilter);
    const haystack = `${task.text} ${task.owner || ""} ${task.sourceLabel}`.toLowerCase();
    return matchesStatus && matchesProject && (!query || haystack.includes(query));
  }).sort((a, b) => {
    if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });

  $("#taskPageList").innerHTML = visible.length ? visible.map((task) => {
    const overdue = !task.completed && task.dueDate && task.dueDate < today;
    return `
      <article class="task-page-row${task.completed ? " completed" : ""}${overdue ? " overdue" : ""}" data-task-kind="${task.sourceKind}" data-task-id="${escapeHtml(task.id)}" data-record-id="${escapeHtml(task.recordId || "")}">
        <input type="checkbox" data-page-task-toggle ${task.completed ? "checked" : ""} aria-label="标记任务完成" />
        <div class="task-page-main">
          <input class="task-page-text" data-page-task-text maxlength="300" value="${escapeHtml(task.text)}" aria-label="编辑任务内容" />
          <span>${escapeHtml(task.sourceLabel)}${overdue ? " · 已逾期" : ""}</span>
        </div>
        <label>项目<select data-page-task-project>${taskProjectOptions(task.projectId)}</select></label>
        <label>负责人<input data-page-task-owner maxlength="60" value="${escapeHtml(task.owner || "")}" placeholder="未指定" /></label>
        <label>截止日期<input data-page-task-due type="date" value="${escapeHtml(task.dueDate || "")}" /></label>
        <button class="task-delete" data-page-task-delete>删除</button>
      </article>`;
  }).join("") : `<div class="task-empty large">当前筛选条件下没有任务，可以在上方手工添加。</div>`;
}

function render() {
  renderFilters();
  renderProjectFilter();
  updateTextCaptureAvailability();
  const query = state.query.trim().toLowerCase();
  const today = dayKey(new Date().toISOString());
  const isTimeline = state.view === "timeline";
  const isTaskPage = isTimeline && state.timelineMode === "tasks";
  const projectMode = isTimeline && state.timelineMode === "project";
  if (!aiTextInputReady() && state.projectPage === "overview") state.projectPage = "timeline";
  const projectOverviewPage = projectMode && state.projectPage === "overview" && state.projectFilter !== "__unassigned__";

  const visible = state.records.filter((record) => {
    const matchesFilter = state.filter === "全部" || record.category === state.filter;
    const matchesView = isTimeline || recordDay(record) === today;
    const matchesProject = !projectMode
      || (state.projectFilter === "__unassigned__" ? !record.projectId : record.projectId === state.projectFilter);
    const haystack = [record.title, record.summary, record.originalName, record.ocrText, ...(record.tags || []), ...(record.owners || []), ...(record.tasks || [])].join(" ").toLowerCase();
    return matchesView && matchesProject && matchesFilter && (!query || haystack.includes(query));
  }).sort((a, b) => recordDay(b).localeCompare(recordDay(a)) || b.createdAt.localeCompare(a.createdAt));

  $$(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === state.view));
  $$("[data-timeline-mode]").forEach((item) => item.classList.toggle("active", item.dataset.timelineMode === state.timelineMode));
  if (isTaskPage) {
    $("#pageTitle").textContent = "任务列表";
    $("#todayLabel").textContent = "TASKS · 可手工编辑的任务工作区";
    $("#searchInput").placeholder = "搜索任务或负责人";
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
  $("#searchInput").placeholder = "搜索标题、内容或标签";
  $("#taskPage").classList.add("hidden");
  $("#recordSectionHead").classList.remove("hidden");
  $$("[data-project-page]").forEach((item) => item.classList.toggle("active", item.dataset.projectPage === state.projectPage));
  $("#pageTitle").textContent = projectOverviewPage ? "项目概览" : isTimeline ? (projectMode ? "项目管理" : "全部工作记录") : "今天的工作记录";
  $("#recordHeading").textContent = projectOverviewPage ? "项目进展与待办" : isTimeline ? (projectMode ? "项目发生记录" : "按发生日期排列") : "最近记录";
  $("#todayLabel").textContent = isTimeline
    ? "LOCAL ARCHIVE · 本地资料库"
    : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());
  $("#dropZone").classList.toggle("hidden", isTimeline);
  $("#timelineToolbar").classList.toggle("hidden", !isTimeline);
  $("#projectFilterWrap").classList.toggle("hidden", !projectMode);
  $("#projectPageTabs").classList.toggle("hidden", !projectMode || state.projectFilter === "__unassigned__" || !aiTextInputReady());
  $("#filters").classList.toggle("hidden", projectOverviewPage);
  $("#recordCount").textContent = `${visible.length} 条`;

  if (isTimeline) {
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
  $("#emptyState h3").textContent = projectMode ? "这个项目还没有记录" : isTimeline ? "这里还没有工作记录" : "今天还没有记录";
  $("#emptyState p").textContent = isTimeline ? "回到“今天”，添加资料或调整记录所属项目。" : "添加第一份工作资料，看看本地读取和自动整理的效果。";
  $("#emptyState").classList.toggle("hidden", projectOverviewPage || visible.length > 0);
  $("#records").classList.toggle("hidden", projectOverviewPage || visible.length === 0);
}

async function refresh() {
  [state.settings, state.records, state.manualTasks] = await Promise.all([
    window.worktrace.getSettings(),
    window.worktrace.listRecords(),
    window.worktrace.listTasks(),
  ]);
  $("#setupBanner").classList.toggle("hidden", Boolean(state.settings.libraryPath));
  $("#pickFiles").disabled = !state.settings.libraryPath;
  render();
}

async function chooseLibrary() {
  const result = await window.worktrace.chooseLibrary();
  if (result) {
    state.settings = result;
    state.records = await window.worktrace.listRecords();
    state.manualTasks = await window.worktrace.listTasks();
    $("#setupBanner").classList.add("hidden");
    $("#pickFiles").disabled = false;
    toast("工作资料库已设置");
    render();
  }
}

async function importPaths(paths) {
  if (!paths.length) return;
  if (!state.settings?.libraryPath) {
    toast("请先选择工作资料库", true);
    return;
  }
  $("#progressWrap").classList.remove("hidden");
  $("#pickFiles").disabled = true;
  $("#progressBar").style.width = "3%";
  $("#progressText").textContent = "准备处理";
  try {
    const supplementalText = aiTextInputReady() ? $("#textCapture").value.trim() : "";
    const records = await window.worktrace.importFiles(paths, supplementalText);
    state.records = [...records, ...state.records];
    if (supplementalText) $("#textCapture").value = "";
    $("#progressBar").style.width = "100%";
    $("#progressText").textContent = `已完成 ${records.length} 条记录`;
    render();
    const categories = [...new Set(records.map((record) => record.category).filter(Boolean))].join("、");
    toast(categories ? `已保存 ${records.length} 份资料，建议分类：${categories}` : `已保存 ${records.length} 份资料`);
  } catch (error) {
    toast(error.message, true);
    $("#progressText").textContent = error.message;
  } finally {
    $("#pickFiles").disabled = false;
    setTimeout(() => $("#progressWrap").classList.add("hidden"), 2400);
  }
}

function renderCategorySettings(categories) {
  $("#categoryList").innerHTML = categories.map((category) => `
    <div class="editable-row" data-category-row data-id="${escapeHtml(category.id)}">
      <input value="${escapeHtml(category.name)}" placeholder="分类名称" maxlength="30" />
      <button type="button" class="remove-row" data-remove-category>删除</button>
    </div>`).join("");
}

function renderProjectSettings(projects) {
  $("#projectList").innerHTML = projects.map((project) => `
    <div class="editable-row project-row" data-project-row data-id="${escapeHtml(project.id)}">
      <input value="${escapeHtml(project.name)}" placeholder="项目名称" maxlength="80" />
      <input value="${escapeHtml(project.owner || "")}" placeholder="负责人（可空）" maxlength="60" />
      <input value="${escapeHtml(Array.isArray(project.aliases) ? project.aliases.join("、") : (project.aliases || ""))}" placeholder="别名，用逗号分隔" />
      <button type="button" class="remove-row" data-remove-project>删除</button>
    </div>`).join("");
  $("#projectEmptyHint").classList.toggle("hidden", projects.length > 0);
}

function populateSettings() {
  const settings = state.settings;
  state.aiTestPassed = Boolean(settings.aiVerified);
  const select = $("#provider");
  const labels = { deepseek: "DeepSeek", qwen: "通义千问", openai: "OpenAI", ollama: "本地 Ollama", custom: "自定义兼容接口" };
  select.innerHTML = Object.keys(settings.providers).map((key) => `<option value="${key}">${labels[key]}</option>`).join("");
  select.value = settings.provider;
  $("#libraryPath").textContent = settings.libraryPath || "尚未选择";
  $("#categoriesEnabled").checked = settings.categoriesEnabled;
  $("#categoryList").classList.toggle("categories-disabled", !settings.categoriesEnabled);
  renderCategorySettings(settings.categories);
  renderProjectSettings(settings.projects);
  $("#aiEnabled").checked = settings.aiEnabled;
  $("#baseUrl").value = settings.baseUrl || "";
  $("#model").value = settings.model || "";
  $("#apiKey").value = "";
  $("#apiKey").placeholder = settings.hasApiKey ? "已安全保存；留空则不更改" : "粘贴服务商提供的 API 密钥";
  $("#keyHint").textContent = settings.aiVerified
    ? "连接已经验证；更换服务商、地址、模型或密钥后需要重新测试。"
    : settings.hasApiKey ? "密钥已经保存，但连接尚未验证。请点击“测试连接”。" : "密钥由系统安全存储，不写入工作资料库。";
  $("#aiFields").style.opacity = settings.aiEnabled ? "1" : ".55";
}

function readCategorySettings() {
  return $$("[data-category-row]").map((row) => ({ id: row.dataset.id, name: row.querySelector("input").value }));
}

function readProjectSettings() {
  return $$("[data-project-row]").map((row) => {
    const inputs = row.querySelectorAll("input");
    return { id: row.dataset.id, name: inputs[0].value, owner: inputs[1].value, aliases: inputs[2].value };
  });
}

function formValue() {
  return {
    aiEnabled: $("#aiEnabled").checked,
    provider: $("#provider").value,
    baseUrl: $("#baseUrl").value,
    model: $("#model").value,
    apiKey: $("#apiKey").value,
    aiVerified: state.aiTestPassed,
    categoriesEnabled: $("#categoriesEnabled").checked,
    categories: readCategorySettings(),
    projects: readProjectSettings(),
  };
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

function renderProjectManager(projects) {
  $("#projectManagerList").innerHTML = projects.map((project) => `
    <div class="manager-project-row" data-manager-project data-id="${escapeHtml(project.id)}">
      <span class="manager-project-mark">◇</span>
      <label>项目名称<input value="${escapeHtml(project.name)}" maxlength="80" placeholder="项目名称" /></label>
      <label>负责人<input value="${escapeHtml(project.owner || "")}" maxlength="60" placeholder="可不填" /></label>
      <label>项目别名<input value="${escapeHtml(Array.isArray(project.aliases) ? project.aliases.join("、") : (project.aliases || ""))}" placeholder="多个名称用逗号分隔" /></label>
      <button type="button" class="task-delete" data-manager-remove>删除</button>
    </div>`).join("");
  $("#projectManagerEmpty").classList.toggle("hidden", projects.length > 0);
}

function readProjectManager() {
  return $$('[data-manager-project]').map((row) => {
    const inputs = row.querySelectorAll("input");
    return { id: row.dataset.id, name: inputs[0].value, owner: inputs[1].value, aliases: inputs[2].value };
  });
}

function openNewProjectDialog() {
  $("#newProjectForm").reset();
  renderProjectManager(state.settings.projects);
  $("#newProjectDialog").showModal();
  setTimeout(() => $("#newProjectName").focus(), 0);
}

function closeNewProjectDialog() {
  $("#newProjectDialog").close();
}

$("#chooseLibrary").addEventListener("click", chooseLibrary);
$("#changeLibrary").addEventListener("click", async () => { await chooseLibrary(); populateSettings(); });
$("#pickFiles").addEventListener("click", async () => importPaths(await window.worktrace.chooseFiles()));
$("#openHelp").addEventListener("click", () => $("#helpDialog").showModal());
$("#closeHelp").addEventListener("click", () => $("#helpDialog").close());
[$("#visitHelpSite"), $("#visitContactSite")].forEach((button) => button.addEventListener("click", async () => {
  try {
    await window.worktrace.openExternal("https://shansha.xyz/");
  } catch (error) {
    toast(error.message, true);
  }
}));
$("#saveTextRecord").addEventListener("click", async () => {
  const text = $("#textCapture").value.trim();
  if (!text) {
    toast("请先输入需要保存的文字", true);
    return;
  }
  $("#saveTextRecord").disabled = true;
  try {
    const record = await window.worktrace.createTextRecord(text);
    state.records.unshift(record);
    $("#textCapture").value = "";
    render();
    toast("文字记录已保存并由 AI 整理");
  } catch (error) {
    toast(error.message, true);
  } finally {
    updateTextCaptureAvailability();
  }
});
$("#openSettings").addEventListener("click", () => { populateSettings(); $("#settingsDialog").showModal(); });
$("#openNewProject").addEventListener("click", openNewProjectDialog);
$("#closeNewProject").addEventListener("click", closeNewProjectDialog);
$("#cancelNewProject").addEventListener("click", closeNewProjectDialog);
$("#createProject").addEventListener("click", () => {
  const name = $("#newProjectName").value.trim();
  if (!name) {
    toast("请填写项目名称", true);
    return;
  }
  const projects = readProjectManager();
  if (projects.some((project) => project.name.trim().toLowerCase() === name.toLowerCase())) {
    toast("已经有同名项目了", true);
    return;
  }
  projects.push({
    id: `project-${Date.now()}`,
    name,
    owner: $("#newProjectOwner").value.trim(),
    aliases: $("#newProjectAliases").value.trim(),
  });
  renderProjectManager(projects);
  $("#newProjectName").value = "";
  $("#newProjectOwner").value = "";
  $("#newProjectAliases").value = "";
  $("#newProjectName").focus();
});
$("#projectManagerList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-manager-remove]");
  if (!button) return;
  button.closest("[data-manager-project]").remove();
  $("#projectManagerEmpty").classList.toggle("hidden", $("#projectManagerList").children.length > 0);
});
$("#newProjectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#saveProjectManager");
  button.disabled = true;
  try {
    const projects = readProjectManager();
    if (projects.some((project) => !project.name.trim())) throw new Error("项目名称不能为空");
    state.settings = await window.worktrace.saveProjects(projects);
    [state.records, state.manualTasks] = await Promise.all([window.worktrace.listRecords(), window.worktrace.listTasks()]);
    closeNewProjectDialog();
    render();
    toast("项目修改已保存");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#searchInput").addEventListener("input", (event) => { state.query = event.target.value; render(); });

$$('.nav-item[data-view]').forEach((button) => button.addEventListener("click", () => {
  state.view = button.dataset.view;
  render();
}));

$("#taskComposer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#createTask");
  button.disabled = true;
  try {
    const task = await window.worktrace.createTask({
      text: $("#newTaskText").value,
      projectId: $("#newTaskProject").value,
      owner: $("#newTaskOwner").value,
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

$("#taskStatusFilter").addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-status]");
  if (!button) return;
  state.taskStatus = button.dataset.taskStatus;
  render();
});

$("#taskProjectFilter").addEventListener("change", (event) => {
  state.taskProjectFilter = event.target.value;
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
  } else if (event.target.matches("[data-page-task-project]")) {
    await updatePageTask(row, { projectId: event.target.value }, "所属项目已更新");
  } else if (event.target.matches("[data-page-task-owner]")) {
    await updatePageTask(row, { owner: event.target.value.trim() }, "负责人已更新");
  } else if (event.target.matches("[data-page-task-due]")) {
    await updatePageTask(row, { dueDate: event.target.value }, "截止日期已更新");
  }
});

$("#taskPageList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-page-task-delete]");
  if (!button) return;
  const row = button.closest("[data-task-kind]");
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

$("#filters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  render();
});

$("#timelineToolbar").addEventListener("click", (event) => {
  const modeButton = event.target.closest("button[data-timeline-mode]");
  if (modeButton) {
    state.timelineMode = modeButton.dataset.timelineMode;
    if (state.timelineMode !== "project") state.projectPage = "timeline";
    render();
    return;
  }
  const pageButton = event.target.closest("button[data-project-page]");
  if (!pageButton) return;
  state.projectPage = pageButton.dataset.projectPage;
  render();
  if (state.projectPage === "overview") loadProjectOverview(state.projectFilter);
});

$("#projectFilter").addEventListener("change", (event) => {
  state.projectFilter = event.target.value;
  if (state.projectFilter === "__unassigned__") state.projectPage = "timeline";
  render();
  if (state.projectPage === "overview") loadProjectOverview(state.projectFilter);
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
  if (event.target.closest("[data-add-project-task]")) {
    const record = state.records.find((item) => item.projectId === state.projectFilter);
    if (!record) return;
    const tasks = [...taskItemsFor(record), { id: `${record.id}-task-${Date.now()}`, text: "新待办", completed: false }];
    await updateRecord(record.id, { taskItems: tasks }, "已添加待办，可以直接修改文字");
  }
});

$("#projectDetail").addEventListener("change", async (event) => {
  if (event.target.matches("[data-task-toggle]")) {
    await changeProjectTask(event.target.dataset.recordId, event.target.dataset.taskId, { completed: event.target.checked }, "待办状态已更新");
  }
  if (event.target.matches("[data-task-text]")) {
    await changeProjectTask(event.target.dataset.recordId, event.target.dataset.taskId, { text: event.target.value.trim() }, "待办内容已更新");
  }
});

$("#records").addEventListener("click", (event) => {
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

$("#records").addEventListener("change", (event) => {
  if (event.target.matches("[data-project-select]")) {
    updateRecord(event.target.dataset.projectSelect, { projectId: event.target.value }, "所属项目已更新");
  }
  if (event.target.matches("[data-category-select]")) {
    updateRecord(event.target.dataset.categorySelect, { categoryId: event.target.value }, "资料分类已更新");
  }
  if (event.target.matches("[data-event-date]")) {
    updateRecord(event.target.dataset.eventDate, { eventDate: event.target.value }, "发生日期已更新");
  }
});

$("#provider").addEventListener("change", (event) => {
  const preset = state.settings.providers[event.target.value];
  $("#baseUrl").value = preset.baseUrl;
  $("#model").value = preset.model;
  $("#apiKey").disabled = !preset.requiresKey;
  state.aiTestPassed = false;
});

["#baseUrl", "#model", "#apiKey"].forEach((selector) => $(selector).addEventListener("input", () => {
  state.aiTestPassed = false;
  $("#testResult").textContent = "配置已改变，请重新测试连接";
}));

$("#aiEnabled").addEventListener("change", (event) => {
  $("#aiFields").style.opacity = event.target.checked ? "1" : ".55";
});

$("#categoriesEnabled").addEventListener("change", (event) => {
  $("#categoryList").classList.toggle("categories-disabled", !event.target.checked);
});

$("#addCategory").addEventListener("click", () => {
  const categories = readCategorySettings();
  categories.push({ id: `category-${Date.now()}`, name: "新分类" });
  renderCategorySettings(categories);
});

$("#categoryList").addEventListener("click", (event) => {
  if (event.target.matches("[data-remove-category]")) event.target.closest("[data-category-row]").remove();
});

$("#addProject").addEventListener("click", () => {
  const projects = readProjectSettings();
  projects.push({ id: `project-${Date.now()}`, name: "新项目", owner: "", aliases: [] });
  renderProjectSettings(projects);
});

$("#projectList").addEventListener("click", (event) => {
  if (event.target.matches("[data-remove-project]")) {
    event.target.closest("[data-project-row]").remove();
    $("#projectEmptyHint").classList.toggle("hidden", $("#projectList").children.length > 0);
  }
});

$("#testAi").addEventListener("click", async () => {
  $("#testAi").disabled = true;
  $("#testResult").textContent = "正在测试…";
  try {
    const result = await window.worktrace.testAi(formValue());
    $("#testResult").textContent = `连接成功：${result.title}`;
    state.aiTestPassed = true;
    $("#aiReadyDialog").showModal();
  } catch (error) {
    state.aiTestPassed = false;
    $("#testResult").textContent = `连接失败：${error.message}`;
  } finally {
    $("#testAi").disabled = false;
  }
});

$("#closeAiReady").addEventListener("click", () => $("#aiReadyDialog").close());

$("#saveSettings").addEventListener("click", async () => {
  try {
    state.settings = await window.worktrace.saveSettings(formValue());
    [state.records, state.manualTasks] = await Promise.all([window.worktrace.listRecords(), window.worktrace.listTasks()]);
    $("#settingsDialog").close();
    render();
    toast("设置已保存");
  } catch (error) {
    toast(error.message, true);
  }
});

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
  importPaths(paths);
});

window.worktrace.onProgress((value) => {
  $("#progressWrap").classList.remove("hidden");
  $("#progressBar").style.width = `${Math.max(4, value.progress || 4)}%`;
  $("#progressText").textContent = value.message;
});

refresh().catch((error) => toast(error.message, true));
