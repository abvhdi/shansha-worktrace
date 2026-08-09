const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { finalizeArchive, stageFile } = require("./archive-storage");
const { extractDocumentText } = require("./document-text");
const {
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
} = require("./core");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".doc"]);
const PROVIDERS = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", requiresKey: true },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", requiresKey: true },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", requiresKey: true },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", requiresKey: false },
  custom: { baseUrl: "", model: "", requiresKey: true },
};

function newSettingId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeCategories(input) {
  if (!Array.isArray(input)) return DEFAULT_CATEGORIES.map((item) => ({ ...item }));
  const seen = new Set();
  return input.flatMap((item) => {
    const name = String(item?.name || "").trim().slice(0, 30);
    if (!name) return [];
    let id = String(item?.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50) || newSettingId("category");
    if (seen.has(id)) id = newSettingId("category");
    seen.add(id);
    return [{ id, name }];
  }).slice(0, 30);
}

function normalizeProjects(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.flatMap((item) => {
    const name = String(item?.name || "").trim().slice(0, 80);
    if (!name) return [];
    let id = String(item?.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50) || newSettingId("project");
    if (seen.has(id)) id = newSettingId("project");
    seen.add(id);
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.map((value) => String(value).trim()).filter(Boolean).slice(0, 12)
      : String(item.aliases || "").split(/[，,、]/).map((value) => value.trim()).filter(Boolean).slice(0, 12);
    return [{ id, name, owner: String(item.owner || "").trim().slice(0, 60), aliases }];
  }).slice(0, 100);
}

let mainWindow;
let importQueue = Promise.resolve();
let portableOcrWorker;
const execFileAsync = promisify(execFile);

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadSettingsInternal() {
  const saved = await readJson(settingsPath(), {});
  return {
    libraryPath: saved.libraryPath || "",
    aiEnabled: Boolean(saved.aiEnabled),
    aiVerified: Boolean(saved.aiVerified),
    provider: saved.provider || "deepseek",
    baseUrl: saved.baseUrl || PROVIDERS[saved.provider || "deepseek"].baseUrl,
    model: saved.model || PROVIDERS[saved.provider || "deepseek"].model,
    encryptedApiKey: saved.encryptedApiKey || "",
    categoriesEnabled: saved.categoriesEnabled !== false,
    categories: normalizeCategories(saved.categories),
    projects: normalizeProjects(saved.projects),
  };
}

async function saveSettingsInternal(next) {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
}

function publicSettings(settings) {
  return {
    libraryPath: settings.libraryPath,
    aiEnabled: settings.aiEnabled,
    aiVerified: settings.aiVerified,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: Boolean(settings.encryptedApiKey),
    providers: PROVIDERS,
    categoriesEnabled: settings.categoriesEnabled,
    categories: settings.categories,
    projects: settings.projects,
  };
}

function decryptApiKey(settings) {
  if (!settings.encryptedApiKey) return "";
  if (!safeStorage.isEncryptionAvailable()) return "";
  return safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, "base64"));
}

async function ensureLibrary(libraryPath) {
  if (!libraryPath) throw new Error("请先选择工作资料库");
  await Promise.all([
    fs.mkdir(path.join(libraryPath, "原始资料"), { recursive: true }),
    fs.mkdir(path.join(libraryPath, ".worktrace", "records"), { recursive: true }),
    fs.mkdir(path.join(libraryPath, ".worktrace", "project-overviews"), { recursive: true }),
    fs.mkdir(path.join(libraryPath, ".worktrace", "inbox"), { recursive: true }),
    fs.mkdir(path.join(libraryPath, "导出文件"), { recursive: true }),
  ]);
}

function normalizeTaskItems(input, fallbackTasks = [], recordId = "record") {
  const source = Array.isArray(input) && input.length
    ? input
    : (Array.isArray(fallbackTasks) ? fallbackTasks : []).map((text, index) => ({
      id: `${recordId}-task-${index + 1}`,
      text,
      completed: false,
    }));
  const seen = new Set();
  return source.flatMap((item, index) => {
    const text = String(typeof item === "string" ? item : item?.text || "").trim().slice(0, 300);
    if (!text) return [];
    let id = String(typeof item === "object" ? item?.id || "" : "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 100) || `${recordId}-task-${index + 1}`;
    if (seen.has(id)) id = `${recordId}-task-${index + 1}-${crypto.randomBytes(2).toString("hex")}`;
    seen.add(id);
    const dueDate = String(typeof item === "object" ? item?.dueDate || "" : "");
    return [{
      id,
      text,
      completed: Boolean(typeof item === "object" && item?.completed),
      projectId: String(typeof item === "object" ? item?.projectId || "" : "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50),
      projectIdExplicit: Boolean(typeof item === "object" && (item?.projectIdExplicit || item?.projectId)),
      owner: String(typeof item === "object" ? item?.owner || "" : "").trim().slice(0, 60),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : "",
    }];
  }).slice(0, 50);
}

function normalizeManualTasks(input, projects = []) {
  if (!Array.isArray(input)) return [];
  const validProjects = new Set(projects.map((item) => item.id));
  const seen = new Set();
  return input.flatMap((item) => {
    const text = String(item?.text || "").trim().slice(0, 300);
    if (!text) return [];
    let id = String(item?.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100) || newSettingId("task");
    if (seen.has(id)) id = newSettingId("task");
    seen.add(id);
    const dueDate = String(item?.dueDate || "");
    const projectId = String(item?.projectId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50);
    const createdAt = /^\d{4}-\d{2}T/.test(String(item?.createdAt || "")) ? item.createdAt : new Date().toISOString();
    return [{
      id,
      text,
      completed: Boolean(item?.completed),
      projectId: validProjects.has(projectId) ? projectId : "",
      owner: String(item?.owner || "").trim().slice(0, 60),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : "",
      createdAt,
      updatedAt: /^\d{4}-\d{2}T/.test(String(item?.updatedAt || "")) ? item.updatedAt : createdAt,
    }];
  }).slice(0, 2000);
}

function ocrHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "worktrace-ocr")
    : path.join(__dirname, "..", "native", "worktrace-ocr");
}

async function portableTessdataPath() {
  const dataPackage = require("@tesseract.js-data/chi_sim");
  const targetDir = path.join(app.getPath("userData"), "tessdata");
  const targetFile = path.join(targetDir, "chi_sim.traineddata.gz");
  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.access(targetFile);
  } catch {
    await fs.copyFile(path.join(dataPackage.langPath, "chi_sim.traineddata.gz"), targetFile);
  }
  return targetDir;
}

async function getPortableOcrWorker() {
  if (!portableOcrWorker) {
    const { createWorker } = require("tesseract.js");
    const langPath = await portableTessdataPath();
    portableOcrWorker = await createWorker("chi_sim", 1, {
      langPath,
      logger(message) {
        if (!mainWindow || mainWindow.isDestroyed() || message.status !== "recognizing text") return;
        mainWindow.webContents.send("archive:progress", {
          stage: "ocr",
          progress: Math.round(20 + (message.progress || 0) * 65),
          message: "正在 Windows 本机识别图片文字",
        });
      },
    });
  }
  return portableOcrWorker;
}

async function sha256(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function extractText(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    if (process.platform !== "darwin" || process.env.WORKTRACE_FORCE_PORTABLE_OCR === "1") {
      const worker = await getPortableOcrWorker();
      const result = await worker.recognize(filePath);
      return result.data.text.trim();
    }
    mainWindow?.webContents.send("archive:progress", {
      stage: "ocr",
      progress: 45,
      message: "正在使用系统能力在本机识别图片文字",
    });
    const { stdout } = await execFileAsync(ocrHelperPath(), [filePath], {
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
    });
    return stdout.trim();
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return (await fs.readFile(filePath, "utf8")).slice(0, 200000);
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return extractDocumentText(filePath, extension);
  }
  throw new Error(`暂不读取 ${extension || "该类型"} 文件的正文`);
}

async function requestAnalysis(settings, text, filename) {
  const provider = PROVIDERS[settings.provider] || PROVIDERS.custom;
  const apiKey = decryptApiKey(settings);
  if (!settings.aiEnabled) return null;
  if (provider.requiresKey && !apiKey) throw new Error("尚未保存 API 密钥");
  if (!settings.baseUrl || !settings.model) throw new Error("AI 接口地址或模型名称为空");

  const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "你是严谨的个人工作资料整理助手，只根据输入内容返回 JSON。" },
        {
          role: "user",
          content: buildAnalysisPrompt(redactSensitive(text), filename, {
            categories: settings.categoriesEnabled ? settings.categories.map((item) => item.name) : [],
            projects: settings.projects.map((item) => `${item.name}${item.aliases.length ? `（别名：${item.aliases.join("、")}）` : ""}`),
            today: new Date().toLocaleDateString("en-CA"),
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI 接口返回 ${response.status}：${body.slice(0, 180)}`);
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 接口没有返回分析结果");
  return parseModelJson(content, settings.categoriesEnabled ? settings.categories.map((item) => item.name) : []);
}

async function requestProjectOverview(settings, project, records) {
  const provider = PROVIDERS[settings.provider] || PROVIDERS.custom;
  const apiKey = decryptApiKey(settings);
  if (!settings.aiEnabled) throw new Error("密钥已保存，但请先在设置中打开“启用 AI 自动分类”");
  if (provider.requiresKey && !apiKey) throw new Error("尚未保存 API 密钥");
  if (!settings.baseUrl || !settings.model) throw new Error("AI 接口地址或模型名称为空");
  const risky = (record) => (record.riskNotes || []).some((risk) => risk.includes("内部或保密") || risk.includes("密码"));
  const safeRecords = records.filter((record) => !risky(record)).map((record) => ({
    ...record,
    title: redactSensitive(record.title || ""),
    summary: redactSensitive(record.summary || ""),
    tasks: (record.tasks || []).map(redactSensitive),
    decisions: (record.decisions || []).map(redactSensitive),
    owners: (record.owners || []).map(redactSensitive),
  }));
  if (!safeRecords.length) throw new Error("项目记录都包含保密或密钥风险，已停止发送给云端 AI");

  const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "你是严谨的项目进展整理助手，只根据输入记录返回 JSON。" },
        { role: "user", content: buildProjectOverviewPrompt(project, safeRecords) },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI 接口返回 ${response.status}：${body.slice(0, 180)}`);
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 接口没有返回项目概览");
  return {
    ...parseProjectOverviewJson(content),
    sourceCount: safeRecords.length,
    skippedCount: records.length - safeRecords.length,
  };
}

function resolveCategory(settings, analysis, localResult) {
  if (!settings.categoriesEnabled || settings.categories.length === 0) return { id: "", name: "" };
  const byAiName = settings.categories.find((item) => item.name === analysis.category);
  if (byAiName) return byAiName;
  const byLocalKey = settings.categories.find((item) => item.id === localResult.categoryKey);
  if (byLocalKey) return byLocalKey;
  const byLocalName = settings.categories.find((item) => item.name === localResult.category);
  return byLocalName || settings.categories.find((item) => item.id === "work") || settings.categories[0];
}

function suggestProject(settings, analysis, text, filename) {
  const normalize = (value) => String(value || "").trim().toLowerCase();
  const aiName = normalize(analysis.projectName);
  if (aiName) {
    const match = settings.projects.find((project) =>
      [project.name, ...project.aliases].some((value) => normalize(value) === aiName),
    );
    if (match) {
      return { id: match.id, name: match.name, confidence: analysis.projectConfidence || 0.75, source: "ai" };
    }
    return { id: "", name: analysis.projectName, confidence: analysis.projectConfidence || 0.5, source: "ai-new" };
  }

  const source = normalize(`${filename}\n${text}`);
  const match = settings.projects.find((project) =>
    [project.name, ...project.aliases].some((value) => value && source.includes(normalize(value))),
  );
  return match ? { id: match.id, name: match.name, confidence: 0.7, source: "local" } : null;
}

async function importOne(filePath, supplementalText = "") {
  const settings = await loadSettingsInternal();
  await ensureLibrary(settings.libraryPath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("只能添加文件");

  const id = createId();
  const now = new Date();
  const archiveYear = String(now.getFullYear());
  const archiveMonth = String(now.getMonth() + 1).padStart(2, "0");
  const originalName = path.basename(filePath);
  const storedName = `${id}_${sanitizeFilename(originalName)}`;
  const inboxPath = await stageFile(settings.libraryPath, filePath, storedName);

  mainWindow?.webContents.send("archive:progress", {
    stage: "extract",
    progress: 5,
    message: `正在处理 ${originalName}`,
  });

  let text = "";
  let extractionError = "";
  try {
    text = await extractText(inboxPath);
  } catch (error) {
    extractionError = error.message;
  }
  const supplement = String(supplementalText || "").trim().slice(0, 20000);
  if (supplement) text = [text, `用户补充说明：\n${supplement}`].filter(Boolean).join("\n\n");
  const localResult = classifyLocal(text, originalName);
  const localRisks = detectSensitiveRisks(text);
  const provider = PROVIDERS[settings.provider] || PROVIDERS.custom;
  const aiAvailable = settings.aiEnabled && settings.aiVerified && (!provider.requiresKey || settings.encryptedApiKey);
  let analysis = localResult;
  let aiStatus = aiAvailable ? "completed" : "disabled";
  let aiError = "";

  if (aiAvailable && localRisks.some((risk) => risk.includes("内部或保密") || risk.includes("密码"))) {
    aiStatus = "skipped-sensitive";
  } else if (aiAvailable) {
    mainWindow?.webContents.send("archive:progress", {
      stage: "ai",
      progress: 92,
      message: "正在请求用户配置的 AI 进行整理",
    });
    try {
      analysis = (await requestAnalysis(settings, text, originalName)) || localResult;
    } catch (error) {
      aiStatus = "failed";
      aiError = error.message;
    }
  }

  const category = resolveCategory(settings, analysis, localResult);
  const projectSuggestion = suggestProject(settings, analysis, text, originalName);
  const storedPath = await finalizeArchive(
    settings.libraryPath,
    inboxPath,
    archiveYear,
    archiveMonth,
    storedName,
  );

  mainWindow?.webContents.send("archive:progress", {
    stage: "archive",
    progress: 98,
    message: category.name ? `已完成整理，建议分类“${category.name}”` : "已完成整理，未使用资料分类",
  });

  const record = {
    id,
    createdAt: now.toISOString(),
    originalName,
    storedPath,
    extension: path.extname(filePath).toLowerCase(),
    size: stat.size,
    hash: await sha256(storedPath),
    ocrText: text,
    categoryId: category.id,
    category: category.name,
    title: analysis.title,
    summary: analysis.summary,
    tags: analysis.tags || [],
    tasks: analysis.tasks || [],
    taskItems: normalizeTaskItems(analysis.taskItems, analysis.tasks || [], id),
    participants: analysis.participants || [],
    owners: analysis.owners || [],
    decisions: analysis.decisions || [],
    eventType: analysis.eventType || "",
    eventDate: analysis.eventDate || now.toISOString().slice(0, 10),
    eventDateSource: analysis.eventDate ? "content" : "saved",
    projectId: "",
    suggestedProjectId: projectSuggestion?.id || "",
    suggestedProjectName: projectSuggestion?.name || "",
    projectConfidence: projectSuggestion?.confidence || 0,
    riskNotes: [...new Set([...localRisks, ...(analysis.riskNotes || [])])],
    aiStatus,
    aiError,
    extractionError,
    supplementalText: supplement,
    archivedRelativePath: path.relative(settings.libraryPath, storedPath),
  };

  await fs.writeFile(
    path.join(settings.libraryPath, ".worktrace", "records", `${id}.json`),
    JSON.stringify(record, null, 2),
    "utf8",
  );
  return record;
}

async function createTextRecord(textInput) {
  const text = String(textInput || "").trim().slice(0, 50000);
  if (!text) throw new Error("请输入需要保存的文字");
  const settings = await loadSettingsInternal();
  const provider = PROVIDERS[settings.provider] || PROVIDERS.custom;
  if (!settings.aiEnabled || !settings.aiVerified || (provider.requiresKey && !settings.encryptedApiKey)) {
    throw new Error("请先在设置中启用 AI，并完成连接测试");
  }
  const temporaryPath = path.join(app.getPath("temp"), `worktrace-text-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.txt`);
  await fs.writeFile(temporaryPath, text, "utf8");
  try {
    return await importOne(temporaryPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function listRecords() {
  const settings = await loadSettingsInternal();
  if (!settings.libraryPath) return [];
  const recordsDir = path.join(settings.libraryPath, ".worktrace", "records");
  try {
    const names = await fs.readdir(recordsDir);
    const records = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(recordsDir, name), null)),
    );
    return records.filter(Boolean).map((record) => {
      const category = settings.categories.find((item) => item.id === record.categoryId)
        || settings.categories.find((item) => item.name === record.category);
      return {
        ...record,
        taskItems: normalizeTaskItems(record.taskItems, record.tasks, record.id),
        category: settings.categoriesEnabled ? (category?.name || record.category || "") : "",
      };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

function manualTasksPath(libraryPath) {
  return path.join(libraryPath, ".worktrace", "tasks.json");
}

async function listManualTasks() {
  const settings = await loadSettingsInternal();
  if (!settings.libraryPath) return [];
  const tasks = await readJson(manualTasksPath(settings.libraryPath), []);
  return normalizeManualTasks(tasks, settings.projects).sort((a, b) => {
    if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

async function saveManualTasks(settings, tasks) {
  await ensureLibrary(settings.libraryPath);
  const normalized = normalizeManualTasks(tasks, settings.projects);
  await fs.writeFile(manualTasksPath(settings.libraryPath), JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

async function reconcileRecordsWithSettings(settings) {
  if (!settings.libraryPath) return;
  const recordsDir = path.join(settings.libraryPath, ".worktrace", "records");
  let names = [];
  try {
    names = await fs.readdir(recordsDir);
  } catch {
    names = [];
  }
  const validProjects = new Set(settings.projects.map((item) => item.id));
  const validCategories = new Set(settings.categories.map((item) => item.id));
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const recordPath = path.join(recordsDir, name);
    const record = await readJson(recordPath, null);
    if (!record) return;
    let changed = false;
    if (record.projectId && !validProjects.has(record.projectId)) {
      record.projectId = "";
      changed = true;
    }
    if (record.suggestedProjectId && !validProjects.has(record.suggestedProjectId)) {
      record.suggestedProjectId = "";
      changed = true;
    }
    if (record.categoryId && !validCategories.has(record.categoryId)) {
      record.categoryId = "";
      record.category = "";
      changed = true;
    }
    if (Array.isArray(record.taskItems)) {
      const nextTasks = normalizeTaskItems(record.taskItems, [], record.id).map((task) => ({
        ...task,
        projectId: validProjects.has(task.projectId) ? task.projectId : "",
        projectIdExplicit: validProjects.has(task.projectId) ? task.projectIdExplicit : false,
      }));
      if (JSON.stringify(nextTasks) !== JSON.stringify(record.taskItems)) {
        record.taskItems = nextTasks;
        record.tasks = nextTasks.map((task) => task.text);
        changed = true;
      }
    }
    if (changed) await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
  }));
  const manualTasks = await readJson(manualTasksPath(settings.libraryPath), []);
  await saveManualTasks(settings, manualTasks);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f3ede3",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle("settings:get", async () => publicSettings(await loadSettingsInternal()));
  ipcMain.handle("app:openExternal", async (_event, urlInput) => {
    const url = new URL(String(urlInput || ""));
    if (url.protocol !== "https:" || !["shansha.xyz", "www.shansha.xyz"].includes(url.hostname)) {
      throw new Error("只能打开珊莎官方网站");
    }
    await shell.openExternal(url.href);
    return true;
  });
  ipcMain.handle("settings:chooseLibrary", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const settings = await loadSettingsInternal();
    settings.libraryPath = result.filePaths[0];
    await ensureLibrary(settings.libraryPath);
    await saveSettingsInternal(settings);
    await reconcileRecordsWithSettings(settings);
    return publicSettings(settings);
  });
  ipcMain.handle("settings:save", async (_event, input) => {
    const settings = await loadSettingsInternal();
    const connectionChanged = settings.provider !== input.provider
      || settings.baseUrl !== String(input.baseUrl || "").trim()
      || settings.model !== String(input.model || "").trim()
      || Boolean(input.apiKey);
    settings.aiEnabled = Boolean(input.aiEnabled);
    settings.provider = input.provider in PROVIDERS ? input.provider : "custom";
    settings.baseUrl = String(input.baseUrl || "").trim();
    settings.model = String(input.model || "").trim();
    settings.categoriesEnabled = input.categoriesEnabled !== false;
    settings.categories = normalizeCategories(input.categories);
    settings.projects = normalizeProjects(input.projects);
    if (input.removeApiKey) {
      settings.encryptedApiKey = "";
      settings.aiVerified = false;
    } else if (input.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统无法安全保存 API 密钥");
      settings.encryptedApiKey = safeStorage.encryptString(String(input.apiKey).trim()).toString("base64");
    }
    settings.aiVerified = Boolean(input.aiVerified) && !input.removeApiKey;
    if (connectionChanged && !input.aiVerified) settings.aiVerified = false;
    await saveSettingsInternal(settings);
    await reconcileRecordsWithSettings(settings);
    return publicSettings(settings);
  });
  ipcMain.handle("projects:create", async (_event, input) => {
    const settings = await loadSettingsInternal();
    if (settings.projects.length >= 100) throw new Error("项目数量已达到上限");
    const project = normalizeProjects([{
      id: newSettingId("project"),
      name: input?.name,
      owner: input?.owner,
      aliases: input?.aliases,
    }])[0];
    if (!project) throw new Error("请填写项目名称");
    const duplicate = settings.projects.some((item) => item.name.toLowerCase() === project.name.toLowerCase());
    if (duplicate) throw new Error("已经有同名项目了");
    settings.projects = normalizeProjects([...settings.projects, project]);
    await saveSettingsInternal(settings);
    return { settings: publicSettings(settings), project };
  });
  ipcMain.handle("projects:save", async (_event, input) => {
    const settings = await loadSettingsInternal();
    const projects = normalizeProjects(input);
    const names = new Set();
    for (const project of projects) {
      const key = project.name.toLowerCase();
      if (names.has(key)) throw new Error(`项目名称重复：${project.name}`);
      names.add(key);
    }
    settings.projects = projects;
    await saveSettingsInternal(settings);
    await reconcileRecordsWithSettings(settings);
    return publicSettings(settings);
  });
  ipcMain.handle("projects:getOverview", async (_event, projectIdInput) => {
    const projectId = String(projectIdInput || "");
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("项目编号无效");
    const settings = await loadSettingsInternal();
    if (!settings.libraryPath) return null;
    return readJson(path.join(settings.libraryPath, ".worktrace", "project-overviews", `${projectId}.json`), null);
  });
  ipcMain.handle("projects:generateOverview", async (_event, projectIdInput) => {
    const projectId = String(projectIdInput || "");
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("项目编号无效");
    const settings = await loadSettingsInternal();
    if (!settings.aiEnabled || !settings.aiVerified) throw new Error("请先在设置中完成 AI 连接测试");
    const project = settings.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    await ensureLibrary(settings.libraryPath);
    const records = (await listRecords()).filter((record) => record.projectId === projectId);
    if (!records.length) throw new Error("这个项目还没有记录，暂时无法生成概览");
    const generated = await requestProjectOverview(settings, project, records);
    const overview = {
      projectId,
      generatedAt: new Date().toISOString(),
      model: settings.model,
      ...generated,
    };
    await fs.writeFile(
      path.join(settings.libraryPath, ".worktrace", "project-overviews", `${projectId}.json`),
      JSON.stringify(overview, null, 2),
      "utf8",
    );
    return overview;
  });
  ipcMain.handle("ai:test", async (_event, input) => {
    const current = await loadSettingsInternal();
    const settings = {
      ...current,
      aiEnabled: true,
      provider: input.provider,
      baseUrl: String(input.baseUrl || "").trim(),
      model: String(input.model || "").trim(),
    };
    if (input.apiKey) {
      settings.encryptedApiKey = safeStorage.encryptString(String(input.apiKey).trim()).toString("base64");
    }
    const result = await requestAnalysis(settings, "项目会议确认：周五前提交修改版本。", "连接测试.txt");
    return { ok: true, title: result.title };
  });
  ipcMain.handle("tasks:list", listManualTasks);
  ipcMain.handle("tasks:create", async (_event, input) => {
    const settings = await loadSettingsInternal();
    await ensureLibrary(settings.libraryPath);
    const current = await listManualTasks();
    if (current.length >= 2000) throw new Error("任务数量已达到上限");
    const now = new Date().toISOString();
    const task = normalizeManualTasks([{
      id: newSettingId("task"),
      text: input?.text,
      completed: false,
      projectId: input?.projectId,
      owner: input?.owner,
      dueDate: input?.dueDate,
      createdAt: now,
      updatedAt: now,
    }], settings.projects)[0];
    if (!task) throw new Error("请填写任务内容");
    await saveManualTasks(settings, [task, ...current]);
    return task;
  });
  ipcMain.handle("tasks:update", async (_event, input) => {
    const id = String(input?.id || "");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("任务编号无效");
    const settings = await loadSettingsInternal();
    const current = await listManualTasks();
    const index = current.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("没有找到这条任务");
    const updated = normalizeManualTasks([{
      ...current[index],
      ...(Object.hasOwn(input, "text") ? { text: input.text } : {}),
      ...(Object.hasOwn(input, "completed") ? { completed: input.completed } : {}),
      ...(Object.hasOwn(input, "projectId") ? { projectId: input.projectId } : {}),
      ...(Object.hasOwn(input, "owner") ? { owner: input.owner } : {}),
      ...(Object.hasOwn(input, "dueDate") ? { dueDate: input.dueDate } : {}),
      updatedAt: new Date().toISOString(),
    }], settings.projects)[0];
    if (!updated) throw new Error("任务内容不能为空");
    current[index] = updated;
    await saveManualTasks(settings, current);
    return updated;
  });
  ipcMain.handle("tasks:delete", async (_event, idInput) => {
    const id = String(idInput || "");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("任务编号无效");
    const settings = await loadSettingsInternal();
    const current = await listManualTasks();
    const next = current.filter((item) => item.id !== id);
    if (next.length === current.length) throw new Error("没有找到这条任务");
    await saveManualTasks(settings, next);
    return true;
  });
  ipcMain.handle("archive:chooseFiles", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "工作资料", extensions: ["pdf", "docx", "doc", "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "txt", "md", "csv", "json"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("archive:import", async (_event, input) => {
    const filePaths = Array.isArray(input) ? input : (Array.isArray(input?.filePaths) ? input.filePaths : []);
    const supplementalText = Array.isArray(input) ? "" : String(input?.supplementalText || "").trim().slice(0, 20000);
    const task = async () => {
      const results = [];
      for (const filePath of filePaths) {
        results.push(await importOne(filePath, supplementalText));
      }
      return results;
    };
    const queued = importQueue.then(task, task);
    importQueue = queued.catch(() => {});
    return queued;
  });
  ipcMain.handle("archive:createText", async (_event, text) => {
    const task = () => createTextRecord(text);
    const queued = importQueue.then(task, task);
    importQueue = queued.catch(() => {});
    return queued;
  });
  ipcMain.handle("archive:list", listRecords);
  ipcMain.handle("archive:updateRecord", async (_event, input) => {
    const id = String(input?.id || "");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("记录编号无效");
    const settings = await loadSettingsInternal();
    await ensureLibrary(settings.libraryPath);
    const recordPath = path.join(settings.libraryPath, ".worktrace", "records", `${id}.json`);
    const record = await readJson(recordPath, null);
    if (!record) throw new Error("没有找到这条记录");

    if (Object.hasOwn(input, "projectId")) {
      const projectId = String(input.projectId || "");
      if (projectId && !settings.projects.some((item) => item.id === projectId)) throw new Error("项目不存在");
      record.projectId = projectId;
      record.projectConfirmedAt = new Date().toISOString();
    }
    if (Object.hasOwn(input, "categoryId")) {
      const categoryId = String(input.categoryId || "");
      const category = settings.categories.find((item) => item.id === categoryId);
      record.categoryId = category?.id || "";
      record.category = category?.name || "";
    }
    if (Object.hasOwn(input, "eventDate")) {
      const eventDate = String(input.eventDate || "");
      if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new Error("日期格式无效");
      record.eventDate = eventDate || record.createdAt.slice(0, 10);
      record.eventDateSource = "manual";
    }
    if (Object.hasOwn(input, "taskItems")) {
      const validProjects = new Set(settings.projects.map((item) => item.id));
      record.taskItems = normalizeTaskItems(input.taskItems, [], record.id).map((task) => ({
        ...task,
        projectId: validProjects.has(task.projectId) ? task.projectId : "",
        projectIdExplicit: task.projectIdExplicit && (task.projectId === "" || validProjects.has(task.projectId)),
      }));
      record.tasks = record.taskItems.map((item) => item.text);
    }
    await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
    return record;
  });
  ipcMain.handle("archive:deleteRecord", async (_event, input) => {
    const id = String(input?.id || "");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("记录编号无效");
    const settings = await loadSettingsInternal();
    await ensureLibrary(settings.libraryPath);
    const recordPath = path.join(settings.libraryPath, ".worktrace", "records", `${id}.json`);
    const record = await readJson(recordPath, null);
    if (!record) throw new Error("没有找到这条记录");
    if (input?.trashOriginal && record.storedPath) {
      const libraryRoot = `${path.resolve(settings.libraryPath)}${path.sep}`;
      const originalPath = path.resolve(record.storedPath);
      if (!originalPath.startsWith(libraryRoot)) throw new Error("原文件不在当前资料库中，已停止删除");
      try {
        await fs.access(originalPath);
        await shell.trashItem(originalPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw new Error(`原文件无法移到废纸篓：${error.message}`);
      }
    }
    await fs.unlink(recordPath);
    return { id, originalKept: !input?.trashOriginal };
  });
  ipcMain.handle("archive:reveal", async (_event, filePath) => shell.showItemInFolder(filePath));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (portableOcrWorker) portableOcrWorker.terminate().catch(() => {});
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
