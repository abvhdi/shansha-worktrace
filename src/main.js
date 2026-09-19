const { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  OTHER_CATEGORY,
  applyCategoryChanges,
  archiveFileToCategory,
  categoriesFromFolders,
  discoverCategoryFolders,
  ensureCategoryFolders,
  moveRecordToCategory,
  replacePathPrefix,
  scanCategoryFiles,
} = require("./category-folders");
const { extractDocumentText } = require("./document-text");
const { createOfficeBuffer } = require("./office-files");
const { uniquePath } = require("./archive-storage");
const { buildVisionContent } = require("./vision-payload");
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
} = require("./core");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"]);
const SPREADSHEET_EXTENSIONS = new Set([".csv", ".json", ".xlsx", ".xls"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx"]);
const PROVIDERS = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", requiresKey: true, models: ["deepseek-chat", "deepseek-reasoner"] },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", requiresKey: true, models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen3-max", "qwen3-plus", "qwen-vl-plus", "qwen-vl-max"] },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", requiresKey: true, models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini"] },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", requiresKey: false, models: [] },
  custom: { baseUrl: "", model: "", requiresKey: true, models: [] },
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

function withOtherCategory(categories) {
  return [...categories.filter((item) => item.id !== OTHER_CATEGORY.id && item.name !== OTHER_CATEGORY.name), { ...OTHER_CATEGORY }].slice(-30);
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
    const createdAt = /^\d{4}-\d{2}-\d{2}T/.test(String(item.createdAt || "")) ? String(item.createdAt) : "";
    return [{
      id,
      name,
      owner: String(item.owner || "").trim().slice(0, 60),
      aliases,
      groupId: String(item.groupId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50),
      createdAt,
    }];
  }).slice(0, 100);
}

function normalizeProjectGroups(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.flatMap((item) => {
    const name = String(item?.name || "").trim().slice(0, 40);
    if (!name) return [];
    let id = String(item?.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50) || newSettingId("group");
    if (seen.has(id)) id = newSettingId("group");
    seen.add(id);
    return [{ id, name }];
  }).slice(0, 30);
}

let mainWindow;
let importQueue = Promise.resolve();
let portableOcrWorker;
let libraryWatcher;
let librarySyncTimer;
let librarySyncBusy = false;
let reminderTimer;
let reminderCheckBusy = false;
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
    visionEnabled: Boolean(saved.visionEnabled),
    aiVerified: Boolean(saved.aiVerified),
    provider: saved.provider || "deepseek",
    baseUrl: saved.baseUrl || PROVIDERS[saved.provider || "deepseek"].baseUrl,
    model: saved.model || PROVIDERS[saved.provider || "deepseek"].model,
    encryptedApiKey: saved.encryptedApiKey || "",
    categoriesEnabled: saved.categoriesEnabled !== false,
    categories: withOtherCategory(normalizeCategories(saved.categories)),
    projects: normalizeProjects(saved.projects),
    projectGroups: normalizeProjectGroups(saved.projectGroups),
    projectGroupMode: ["none", "month", "custom"].includes(saved.projectGroupMode) ? saved.projectGroupMode : "none",
    moveArchiveConfirmed: Boolean(saved.moveArchiveConfirmed),
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
    visionEnabled: settings.visionEnabled,
    aiVerified: settings.aiVerified,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: Boolean(settings.encryptedApiKey),
    providers: PROVIDERS,
    categoriesEnabled: settings.categoriesEnabled,
    categories: settings.categories,
    projects: settings.projects,
    projectGroups: settings.projectGroups,
    projectGroupMode: settings.projectGroupMode,
  };
}

function isInside(rootPath, candidatePath) {
  const root = `${path.resolve(rootPath)}${path.sep}`;
  return path.resolve(candidatePath).startsWith(root);
}

function decryptApiKey(settings) {
  if (!settings.encryptedApiKey) return "";
  if (!safeStorage.isEncryptionAvailable()) return "";
  try {
    return normalizeApiKey(safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, "base64")));
  } catch {
    return "";
  }
}

// Users often paste a key together with quotes, a Bearer prefix, or an
// environment-variable name. Accept those harmless variations, but never
// include the key itself in an error message.
function normalizeApiKey(value) {
  let key = String(value || "").trim();
  if (!key) return "";
  const assignment = key.match(/^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|API)[A-Z0-9_]*\s*=\s*(.+)$/i);
  if (assignment) key = assignment[1].trim();
  key = key.replace(/^Bearer\s+/i, "").trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

function normalizeBaseUrl(value) {
  let url = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  url = url.replace(/\/+$/, "");
  // The app appends this path. Removing it prevents the common
  // /chat/completions/chat/completions mistake when a full endpoint is pasted.
  return url.replace(/\/chat\/completions$/i, "");
}

function aiConfigError(settings) {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  if (!baseUrl) return "请填写接口地址";
  try {
    const parsed = new URL(`${baseUrl}/chat/completions`);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocol");
  } catch {
    return "接口地址格式不正确，请填写以 http:// 或 https:// 开头的地址";
  }
  if (!settings.model) return "请填写模型名称（可先使用服务商提供的默认模型）";
  return "";
}

function aiHttpError(status, body) {
  const detail = String(body || "").toLowerCase();
  if (status === 401 || status === 403 || /invalid api key|incorrect api key|authentication|unauthorized|forbidden/.test(detail)) {
    return "API Key 无效或没有权限，请重新复制服务商提供的 Key";
  }
  if (status === 404) {
    return /model|deployment/.test(detail)
      ? "找不到这个模型，请检查模型名称是否与服务商一致"
      : "找不到接口，请检查接口地址（不要填写完整的 /chat/completions 路径）";
  }
  if (status === 400) return /model|deployment/.test(detail)
    ? "模型名称或模型能力不匹配，请换成服务商支持的模型"
    : "服务商拒绝了这次请求，请检查接口地址和模型设置";
  if (status === 429) return "服务商暂时限流或额度不足，请稍后再试或检查账户余额";
  if (status >= 500) return "AI 服务商暂时不可用，请稍后再试";
  return `AI 服务返回错误（${status}），请检查接口地址、模型和 API Key`;
}

async function fetchAiCompletion(settings, body) {
  const configError = aiConfigError(settings);
  if (configError) throw new Error(configError);
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const apiKey = decryptApiKey(settings);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(aiHttpError(response.status, responseBody));
    }
    return await response.json();
  } catch (error) {
    if (error?.message && !/fetch failed|network|connect|socket/i.test(error.message)) throw error;
    throw new Error("无法连接 AI 服务，请检查网络和接口地址");
  }
}

async function ensureLibrary(libraryPath) {
  if (!libraryPath) throw new Error("请先选择工作资料库");
  await Promise.all([
    fs.mkdir(path.join(libraryPath, "原始资料"), { recursive: true }),
    fs.mkdir(path.join(libraryPath, ".worktrace", "records"), { recursive: true }),
    fs.mkdir(path.join(libraryPath, ".worktrace", "project-overviews"), { recursive: true }),
    fs.mkdir(path.join(libraryPath, ".worktrace", "inbox"), { recursive: true }),
    fs.mkdir(path.join(libraryPath, "导出文件"), { recursive: true }),
    fs.mkdir(path.join(libraryPath, OTHER_CATEGORY.name), { recursive: true }),
  ]);
}

async function updateRecordPathsForCategoryChanges(settings, pathChanges) {
  if (!pathChanges.length) return;
  const recordsDir = path.join(settings.libraryPath, ".worktrace", "records");
  let names = [];
  try {
    names = await fs.readdir(recordsDir);
  } catch {
    return;
  }
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const recordPath = path.join(recordsDir, name);
    const record = await readJson(recordPath, null);
    if (!record?.storedPath) continue;
    const changed = replacePathPrefix(record.storedPath, pathChanges);
    if (!changed) continue;
    record.storedPath = changed.path;
    record.archivedRelativePath = path.relative(settings.libraryPath, changed.path);
    record.categoryId = changed.categoryId;
    record.category = changed.category;
    await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
  }
}

async function refreshRecordContent(record, filePath, stat) {
  let text = "";
  let extractionError = "";
  try {
    text = await extractText(filePath);
  } catch (error) {
    extractionError = error.message;
  }
  const local = classifyLocal(text, path.basename(filePath));
  record.ocrText = text;
  record.size = stat.size;
  record.hash = await sha256(filePath).catch(() => record.hash || "");
  record.fileModifiedAt = stat.mtime.toISOString();
  record.contentIndexedAt = new Date().toISOString();
  record.extractionError = extractionError;
  if (!record.title || (record.source === "folder-scan" && record.titleSource !== "manual")) {
    record.title = local.title || record.title || record.originalName;
    record.titleSource = "local";
  }
  if (record.source === "folder-scan" || !record.summary) {
    record.summary = local.summary || record.summary || record.originalName;
  }
  return record;
}

async function indexExistingLibraryFiles(settings) {
  await ensureCategoryFolders(settings.libraryPath, settings.categories);
  const discovered = await scanCategoryFiles(settings.libraryPath, settings.categories);
  const recordsDir = path.join(settings.libraryPath, ".worktrace", "records");
  const names = await fs.readdir(recordsDir).catch(() => []);
  const existing = new Map();
  const missingBySignature = new Map();
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const recordPath = path.join(recordsDir, name);
    const record = await readJson(recordPath, null);
    if (!record?.storedPath) continue;
    const resolvedPath = path.resolve(record.storedPath);
    existing.set(resolvedPath, { record, recordPath });
    try {
      await fs.access(resolvedPath);
    } catch {
      const signature = `${record.originalName}\u0000${record.size}`;
      const candidates = missingBySignature.get(signature) || [];
      candidates.push({ record, recordPath, resolvedPath });
      missingBySignature.set(signature, candidates);
    }
  }

  let added = 0;
  let updated = 0;
  let failed = 0;
  for (const [index, item] of discovered.entries()) {
    const resolved = path.resolve(item.filePath);
    const stat = await fs.stat(item.filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const known = existing.get(resolved);
    if (known) {
      let changed = false;
      if (known.record.categoryId !== item.categoryId || known.record.category !== item.category) {
        known.record.categoryId = item.categoryId;
        known.record.category = item.category;
        changed = true;
      }
      const indexedModifiedAt = Date.parse(known.record.fileModifiedAt || "");
      const contentChanged = !Number.isFinite(indexedModifiedAt)
        || Math.abs(indexedModifiedAt - stat.mtimeMs) > 1
        || Number(known.record.size || 0) !== stat.size;
      if (contentChanged) {
        try {
          await refreshRecordContent(known.record, item.filePath, stat);
          updated += 1;
        } catch (error) {
          known.record.contentIndexedAt = new Date().toISOString();
          known.record.extractionError = `重新读取失败：${error.message}`;
          failed += 1;
        }
        changed = true;
      }
      if (changed) await fs.writeFile(known.recordPath, JSON.stringify(known.record, null, 2), "utf8");
      continue;
    }
    const signature = `${path.basename(item.filePath)}\u0000${stat.size}`;
    const movedCandidates = missingBySignature.get(signature) || [];
    if (movedCandidates.length === 1) {
      const moved = movedCandidates[0];
      moved.record.storedPath = item.filePath;
      moved.record.archivedRelativePath = path.relative(settings.libraryPath, item.filePath);
      moved.record.categoryId = item.categoryId;
      moved.record.category = item.category;
      moved.record.fileModifiedAt = stat.mtime.toISOString();
      await fs.writeFile(moved.recordPath, JSON.stringify(moved.record, null, 2), "utf8");
      missingBySignature.delete(signature);
      continue;
    }
    const id = createId();
    const originalName = path.basename(item.filePath);
    const localResult = classifyLocal("", originalName);
    const createdAt = (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString();
    const relative = path.relative(settings.libraryPath, item.filePath);
    const record = {
      id,
      createdAt,
      originalName,
      storedPath: item.filePath,
      extension: path.extname(item.filePath).toLowerCase(),
      size: stat.size,
      hash: "",
      ocrText: "",
      categoryId: item.categoryId,
      category: item.category,
      title: localResult.title,
      summary: `来自工作文件夹：${relative}`,
      tags: [], tasks: [], taskItems: [], participants: [], owners: [], decisions: [],
      eventType: "",
      eventDate: stat.mtime.toISOString().slice(0, 10),
      eventDateSource: "file-modified",
      projectId: "",
      projectAssignmentSource: "unassigned",
      projectConfirmedAt: "",
      suggestedProjectId: "",
      suggestedProjectName: "",
      projectConfidence: 0,
      riskNotes: [],
      aiStatus: "not-run",
      aiError: "",
      extractionError: "",
      supplementalText: "",
      archivedRelativePath: relative,
      source: "folder-scan",
    };
    await refreshRecordContent(record, item.filePath, stat);
    await fs.writeFile(path.join(recordsDir, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
    added += 1;
    if (index % 25 === 0) mainWindow?.webContents.send("archive:progress", { stage: "scan", progress: 10, message: `正在识别工作文件夹，已发现 ${index + 1} 个文件` });
  }
  return { added, updated, failed, total: discovered.length };
}

async function syncSettingsFromLibraryFolders(settings) {
  const folderNames = await discoverCategoryFolders(settings.libraryPath);
  const meaningfulFolders = folderNames.filter((name) => name !== OTHER_CATEGORY.name);
  if (meaningfulFolders.length) {
    const previous = settings.categories.filter((item) => item.id !== OTHER_CATEGORY.id);
    const previousNames = new Set(previous.map((item) => item.name));
    const folderNameSet = new Set(meaningfulFolders);
    const removed = previous.filter((item) => !folderNameSet.has(item.name));
    const added = meaningfulFolders.filter((name) => !previousNames.has(name));
    if (removed.length === 1 && added.length === 1) {
      const renamed = removed[0];
      const nextName = added[0];
      const pathChanges = [{
        from: path.join(settings.libraryPath, renamed.name),
        to: path.join(settings.libraryPath, nextName),
        categoryId: renamed.id,
        category: nextName,
      }];
      await updateRecordPathsForCategoryChanges(settings, pathChanges);
      settings.categories = settings.categories.map((item) => item.id === renamed.id ? { ...item, name: nextName } : item);
    }
    settings.categories = categoriesFromFolders(folderNames, settings.categories);
  }
  else await ensureCategoryFolders(settings.libraryPath, settings.categories);
  settings.categories = withOtherCategory(settings.categories);
  return indexExistingLibraryFiles(settings);
}

function startLibraryWatcher(libraryPath) {
  if (libraryWatcher) libraryWatcher.close();
  libraryWatcher = null;
  clearTimeout(librarySyncTimer);
  if (!libraryPath) return;
  try {
    libraryWatcher = fsSync.watch(libraryPath, { recursive: true }, (_eventType, filename) => {
      const relative = String(filename || "");
      if (!relative || relative === ".worktrace" || relative.startsWith(`.worktrace${path.sep}`)) return;
      clearTimeout(librarySyncTimer);
      librarySyncTimer = setTimeout(async () => {
        if (librarySyncBusy) return;
        librarySyncBusy = true;
        try {
          const settings = await loadSettingsInternal();
          if (path.resolve(settings.libraryPath || "") !== path.resolve(libraryPath)) return;
          const scan = await syncSettingsFromLibraryFolders(settings);
          await saveSettingsInternal(settings);
          await reconcileRecordsWithSettings(settings);
          mainWindow?.webContents.send("library:changed", scan);
        } catch (error) {
          console.error("工作文件夹同步失败：", error);
        } finally {
          librarySyncBusy = false;
        }
      }, 900);
    });
    libraryWatcher.on("error", (error) => console.error("工作文件夹监听失败：", error));
  } catch (error) {
    console.error("当前系统无法自动监听工作文件夹：", error);
  }
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
    const linkedIds = Array.isArray(typeof item === "object" ? item?.recordIds : [])
      ? item.recordIds.map((value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100)).filter(Boolean)
      : [];
    const sortOrderValue = typeof item === "object" ? item?.sortOrder : null;
    const rawSortOrder = sortOrderValue === null || sortOrderValue === undefined || sortOrderValue === "" ? NaN : Number(sortOrderValue);
    return [{
      id,
      text,
      completed: Boolean(typeof item === "object" && item?.completed),
      projectId: String(typeof item === "object" ? item?.projectId || "" : "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50),
      projectIdExplicit: Boolean(typeof item === "object" && (item?.projectIdExplicit || item?.projectId)),
      owner: String(typeof item === "object" ? item?.owner || "" : "").trim().slice(0, 60),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : "",
      recordIds: [...new Set([recordId, ...linkedIds])].slice(0, 50),
      sortOrder: Number.isFinite(rawSortOrder) ? Math.max(0, Math.min(1000000, Math.round(rawSortOrder))) : null,
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
    const recordIds = Array.isArray(item?.recordIds)
      ? [...new Set(item.recordIds.map((value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100)).filter(Boolean))].slice(0, 50)
      : [];
    const rawSortOrder = item?.sortOrder === null || item?.sortOrder === undefined || item?.sortOrder === "" ? NaN : Number(item.sortOrder);
    return [{
      id,
      text,
      completed: Boolean(item?.completed),
      projectId: validProjects.has(projectId) ? projectId : "",
      owner: String(item?.owner || "").trim().slice(0, 60),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : "",
      recordIds,
      sortOrder: Number.isFinite(rawSortOrder) ? Math.max(0, Math.min(1000000, Math.round(rawSortOrder))) : null,
      createdAt,
      updatedAt: /^\d{4}-\d{2}T/.test(String(item?.updatedAt || "")) ? item.updatedAt : createdAt,
    }];
  }).slice(0, 2000);
}

function taskItemsForCleanup(record, removedRecordId) {
  const current = normalizeTaskItems(record.taskItems, record.tasks, record.id);
  const next = current.map((task) => ({
    ...task,
    recordIds: (task.recordIds || []).filter((recordId) => recordId !== removedRecordId),
  }));
  return JSON.stringify(next) === JSON.stringify(current) ? null : next;
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
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
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

async function requestAnalysis(settings, text, filename, imagePath = "") {
  const provider = PROVIDERS[settings.provider] || PROVIDERS.custom;
  if (!settings.aiEnabled) return null;
  const apiKey = decryptApiKey(settings);
  if (provider.requiresKey && !apiKey) throw new Error("尚未保存 API 密钥，请在设置中填写后再保存");
  const configError = aiConfigError(settings);
  if (configError) throw new Error(configError);

  const prompt = buildAnalysisPrompt(redactSensitive(text), filename, {
    categories: settings.categoriesEnabled ? settings.categories.map((item) => item.name) : [],
    projects: settings.projects.map((item) => `${item.name}${item.aliases.length ? `（别名：${item.aliases.join("、")}）` : ""}`),
    today: new Date().toLocaleDateString("en-CA"),
  });
  let userContent = prompt;
  if (imagePath) userContent = await buildVisionContent(prompt, imagePath);

  const payload = await fetchAiCompletion(settings, {
      model: settings.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "你是严谨的个人工作资料整理助手，只根据输入内容返回 JSON。" },
        { role: "user", content: userContent },
      ],
  });
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 接口没有返回分析结果");
  return parseModelJson(content, settings.categoriesEnabled ? settings.categories.map((item) => item.name) : []);
}

async function requestProjectOverview(settings, project, records) {
  const provider = PROVIDERS[settings.provider] || PROVIDERS.custom;
  const apiKey = decryptApiKey(settings);
  if (!settings.aiEnabled) throw new Error("密钥已保存，但请先在设置中打开“启用 AI 自动分类”");
  if (provider.requiresKey && !apiKey) throw new Error("尚未保存 API 密钥，请在设置中填写后再保存");
  const configError = aiConfigError(settings);
  if (configError) throw new Error(configError);
  const safeRecords = records.map((record) => ({
    ...record,
    title: redactSensitive(record.title || ""),
    summary: redactSensitive(record.summary || ""),
    tasks: (record.tasks || []).map(redactSensitive),
    decisions: (record.decisions || []).map(redactSensitive),
    owners: (record.owners || []).map(redactSensitive),
  }));
  const payload = await fetchAiCompletion(settings, {
      model: settings.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "你是严谨的项目进展整理助手，只根据输入记录返回 JSON。" },
        { role: "user", content: buildProjectOverviewPrompt(project, safeRecords) },
      ],
  });
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 接口没有返回项目概览");
  return {
    ...parseProjectOverviewJson(content),
    sourceCount: safeRecords.length,
    skippedCount: 0,
  };
}

function resolveCategory(settings, analysis, localResult) {
  if (!settings.categoriesEnabled || settings.categories.length === 0) return { id: "", name: "" };
  const byAiName = settings.categories.find((item) => item.name === analysis.category);
  if (byAiName) return byAiName;
  const byLocalKey = settings.categories.find((item) => item.id === localResult.categoryKey);
  if (byLocalKey) return byLocalKey;
  const byLocalName = settings.categories.find((item) => item.name === localResult.category);
  return byLocalName || settings.categories.find((item) => item.id === OTHER_CATEGORY.id) || settings.categories[0];
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
  if (isInside(settings.libraryPath, filePath)) {
    throw new Error("这个文件已经在工作资料库中，无需重复导入");
  }
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("只能添加文件");

  const id = createId();
  const now = new Date();
  const originalName = path.basename(filePath);

  mainWindow?.webContents.send("archive:progress", {
    stage: "extract",
    progress: 5,
    message: `正在处理 ${originalName}`,
  });

  let text = "";
  let extractionError = "";
  try {
    text = await extractText(filePath);
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

  if (aiAvailable) {
    const useVision = settings.visionEnabled && IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    mainWindow?.webContents.send("archive:progress", {
      stage: "ai",
      progress: 92,
      message: useVision ? "正在使用视觉模型结合图片和文字整理" : "正在请求用户配置的 AI 进行整理",
    });
    try {
      analysis = (await requestAnalysis(settings, text, originalName, useVision ? filePath : "")) || localResult;
      if (useVision) aiStatus = "completed-vision";
    } catch (error) {
      aiStatus = "failed";
      aiError = error.message;
    }
  }

  const category = resolveCategory(settings, analysis, localResult);
  const projectSuggestion = suggestProject(settings, analysis, text, originalName);
  const projectId = projectSuggestion?.id || "";
  const eventDate = analysis.eventDate || now.toISOString().slice(0, 10);
  const storedPath = await archiveFileToCategory(settings.libraryPath, filePath, category.name || OTHER_CATEGORY.name, originalName);

  mainWindow?.webContents.send("archive:progress", {
    stage: "archive",
    progress: 98,
    message: category.name ? `已完成整理，已放入“${category.name}”标签文件夹` : "已完成整理",
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
    eventDate,
    eventDateSource: analysis.eventDate ? "content" : "saved",
    projectId,
    projectAssignmentSource: projectId ? projectSuggestion?.source || "automatic" : "unassigned",
    projectConfirmedAt: "",
    suggestedProjectId: projectSuggestion?.id || "",
    suggestedProjectName: projectSuggestion?.name || "",
    projectConfidence: projectSuggestion?.confidence || 0,
    riskNotes: [...new Set([...localRisks, ...(analysis.riskNotes || [])])],
    aiStatus,
    aiError,
    extractionError,
    fileModifiedAt: stat.mtime.toISOString(),
    contentIndexedAt: now.toISOString(),
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
    throw new Error("请先在设置中启用 AI，并保存有效的 AI 配置");
  }
  const temporaryPath = path.join(app.getPath("temp"), `worktrace-text-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.txt`);
  await fs.writeFile(temporaryPath, text, "utf8");
  try {
    return await importOne(temporaryPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function createOfficeRecord(input = {}) {
  const type = ["docx", "xlsx", "pptx"].includes(String(input.type || "")) ? String(input.type) : "";
  if (!type) throw new Error("请选择 Word、Excel 或 PPT");
  const title = String(input.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!title) throw new Error("请填写文件名称");
  const settings = await loadSettingsInternal();
  await ensureLibrary(settings.libraryPath);
  const projectId = String(input.projectId || "");
  if (projectId && !settings.projects.some((item) => item.id === projectId)) throw new Error("项目不存在");

  const typeNames = { docx: "Word 文档", xlsx: "Excel 表格", pptx: "PPT 演示文稿" };
  const folder = path.join(settings.libraryPath, OTHER_CATEGORY.name);
  await fs.mkdir(folder, { recursive: true });
  const storedPath = await uniquePath(folder, `${title}.${type}`);
  const content = String(input.content || "").slice(0, 40000);
  const sheets = Array.isArray(input.sheets) ? input.sheets.slice(0, 8) : [];
  const buffer = await createOfficeBuffer(type, title, { content, sheets });
  await fs.writeFile(storedPath, buffer, { flag: "wx" });

  const now = new Date();
  const stat = await fs.stat(storedPath);
  const record = {
    id: createId(),
    createdAt: now.toISOString(),
    originalName: path.basename(storedPath),
    storedPath,
    extension: `.${type}`,
    size: stat.size,
    hash: await sha256(storedPath),
    ocrText: await extractText(storedPath).catch(() => [title, content].filter(Boolean).join("\n\n")),
    categoryId: OTHER_CATEGORY.id,
    category: OTHER_CATEGORY.name,
    title,
    titleSource: "manual",
    summary: input.sourceRecordId ? `Agent 根据原文件生成的${typeNames[type]}副本` : `Agent 生成的${typeNames[type]}`,
    tags: [], tasks: [], taskItems: [], participants: [], owners: [], decisions: [],
    eventType: "新建文件",
    eventDate: now.toISOString().slice(0, 10),
    eventDateSource: "created",
    projectId,
    projectAssignmentSource: projectId ? "task" : "unassigned",
    projectConfirmedAt: projectId ? now.toISOString() : "",
    suggestedProjectId: "",
    suggestedProjectName: "",
    projectConfidence: 0,
    riskNotes: [],
    aiStatus: "not-run",
    aiError: "",
    extractionError: "",
    fileModifiedAt: stat.mtime.toISOString(),
    contentIndexedAt: now.toISOString(),
    supplementalText: "",
    archivedRelativePath: path.relative(settings.libraryPath, storedPath),
    source: content || sheets.length ? "agent-created" : "task-created",
    derivedFromRecordId: String(input.sourceRecordId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100),
  };
  try {
    await fs.writeFile(
      path.join(settings.libraryPath, ".worktrace", "records", `${record.id}.json`),
      JSON.stringify(record, null, 2),
      { encoding: "utf8", flag: "wx" },
    );
    return record;
  } catch (error) {
    await fs.unlink(storedPath).catch(() => {});
    throw error;
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
    // 先按用户拖动后的顺序（sortOrder），没有顺序的排在后面
    const aRanked = typeof a.sortOrder === "number" && Number.isFinite(a.sortOrder);
    const bRanked = typeof b.sortOrder === "number" && Number.isFinite(b.sortOrder);
    if (aRanked && bRanked && a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (aRanked !== bRanked) return aRanked ? 1 : -1;
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

function portableRecord(record) {
  const copy = { ...record };
  delete copy.storedPath;
  copy.archivedRelativePath = String(copy.archivedRelativePath || "").split(path.sep).join("/");
  return copy;
}

function safeBackupRelativePath(value) {
  const relative = path.normalize(String(value || "").replace(/[\\/]+/g, path.sep)).replace(/^([/\\])+/, "");
  if (!relative || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "";
  return relative;
}

async function exportWorkspaceBackup() {
  const settings = await loadSettingsInternal();
  await ensureLibrary(settings.libraryPath);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出工作台备份",
    defaultPath: `珊莎工作留痕备份-${localDateKey()}.json`,
    filters: [{ name: "工作台备份", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const [records, tasks] = await Promise.all([listRecords(), listManualTasks()]);
  const backup = {
    format: "shansha-worktrace-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: {
      categoriesEnabled: settings.categoriesEnabled,
      categories: settings.categories,
      projects: settings.projects,
      projectGroups: settings.projectGroups,
      projectGroupMode: settings.projectGroupMode,
    },
    records: records.map(portableRecord),
    tasks,
  };
  await fs.writeFile(result.filePath, JSON.stringify(backup, null, 2), { encoding: "utf8", flag: "w" });
  return { path: result.filePath, recordCount: records.length, taskCount: tasks.length };
}

async function importWorkspaceBackup() {
  const settings = await loadSettingsInternal();
  await ensureLibrary(settings.libraryPath);
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "恢复工作台备份",
    properties: ["openFile"],
    filters: [{ name: "工作台备份", extensions: ["json"] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const stat = await fs.stat(picked.filePaths[0]);
  if (stat.size > 50 * 1024 * 1024) throw new Error("备份文件过大，无法安全读取");
  let backup;
  try {
    backup = JSON.parse(await fs.readFile(picked.filePaths[0], "utf8"));
  } catch {
    throw new Error("备份文件无法读取或内容已经损坏");
  }
  if (backup?.format !== "shansha-worktrace-backup" || backup.version !== 1) throw new Error("这不是有效的珊莎工作留痕备份");
  const records = Array.isArray(backup.records) ? backup.records.slice(0, 20000) : [];
  const tasks = Array.isArray(backup.tasks) ? backup.tasks.slice(0, 10000) : [];
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "确认恢复工作台数据",
    message: `恢复 ${records.length} 条记录和 ${tasks.length} 个任务？`,
    detail: "会合并同编号的数据并恢复项目、分组和标签，不会删除资料库里的原文件，也不会导入或覆盖 API Key。",
    buttons: ["恢复", "取消"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) return null;

  const workspace = backup.workspace && typeof backup.workspace === "object" ? backup.workspace : {};
  settings.categoriesEnabled = workspace.categoriesEnabled !== false;
  const incomingCategories = normalizeCategories(workspace.categories);
  const categoryMap = new Map(settings.categories.map((item) => [item.id, item]));
  incomingCategories.forEach((item) => categoryMap.set(item.id, item));
  settings.categories = withOtherCategory([...categoryMap.values()]);
  const incomingProjects = normalizeProjects(workspace.projects);
  const projectMap = new Map(settings.projects.map((item) => [item.id, item]));
  incomingProjects.forEach((item) => projectMap.set(item.id, item));
  settings.projects = normalizeProjects([...projectMap.values()]);
  const incomingGroups = normalizeProjectGroups(workspace.projectGroups);
  const groupMap = new Map(settings.projectGroups.map((item) => [item.id, item]));
  incomingGroups.forEach((item) => groupMap.set(item.id, item));
  settings.projectGroups = normalizeProjectGroups([...groupMap.values()]);
  settings.projectGroupMode = ["none", "month", "custom"].includes(workspace.projectGroupMode) ? workspace.projectGroupMode : "none";
  await saveSettingsInternal(settings);
  await ensureCategoryFolders(settings.libraryPath, settings.categories);

  const recordsDir = path.join(settings.libraryPath, ".worktrace", "records");
  let restoredRecords = 0;
  for (const source of records) {
    const id = String(source?.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
    const relative = safeBackupRelativePath(source?.archivedRelativePath);
    if (!id || !relative) continue;
    const restored = {
      ...source,
      id,
      storedPath: path.join(settings.libraryPath, relative),
      archivedRelativePath: relative,
      taskItems: normalizeTaskItems(source.taskItems, source.tasks, id),
    };
    await fs.writeFile(path.join(recordsDir, `${id}.json`), JSON.stringify(restored, null, 2), "utf8");
    restoredRecords += 1;
  }
  const currentTasks = await listManualTasks();
  const taskMap = new Map(currentTasks.map((task) => [task.id, task]));
  tasks.forEach((task) => {
    if (task?.id) taskMap.set(String(task.id), task);
  });
  const restoredTasks = await saveManualTasks(settings, [...taskMap.values()]);
  await reconcileRecordsWithSettings(settings);
  return { settings: publicSettings(settings), recordCount: restoredRecords, taskCount: restoredTasks.length };
}

function localDateKey(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

async function checkTaskReminders() {
  if (reminderCheckBusy || process.argv.includes("--selftest") || !Notification.isSupported()) return;
  const now = new Date();
  // 截止日期目前没有具体时刻：当天上午 9 点后首次检测时提醒。
  if (now.getHours() < 9) return;
  reminderCheckBusy = true;
  try {
    const settings = await loadSettingsInternal();
    if (!settings.libraryPath) return;
    const today = localDateKey(now);
    const [manualTasks, records] = await Promise.all([listManualTasks(), listRecords()]);
    const dueTasks = [
      ...manualTasks.map((task) => ({ ...task, reminderKey: `manual:${task.id}:${task.dueDate}` })),
      ...records.flatMap((record) => normalizeTaskItems(record.taskItems, record.tasks, record.id).map((task) => ({
        ...task,
        reminderKey: `record:${record.id}:${task.id}:${task.dueDate}`,
      }))),
    ].filter((task) => !task.completed && task.dueDate && task.dueDate <= today);
    if (!dueTasks.length) return;

    const reminderPath = path.join(settings.libraryPath, ".worktrace", "reminders.json");
    const saved = await readJson(reminderPath, {});
    const notified = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    const pending = dueTasks.filter((task) => !notified[task.reminderKey]);
    if (!pending.length) return;

    const overdueCount = pending.filter((task) => task.dueDate < today).length;
    const preview = pending.slice(0, 3).map((task) => `• ${String(task.text || "未命名任务").slice(0, 48)}`).join("\n");
    const more = pending.length > 3 ? `\n另有 ${pending.length - 3} 项` : "";
    const notification = new Notification({
      title: overdueCount ? `${pending.length} 项任务到期或已逾期` : `${pending.length} 项任务今天到期`,
      body: `${preview}${more}`,
      silent: false,
    });
    notification.on("click", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        mainWindow.webContents.once("did-finish-load", () => mainWindow?.webContents.send("tasks:show"));
        return;
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("tasks:show");
    });
    notification.show();

    const notifiedAt = now.toISOString();
    pending.forEach((task) => { notified[task.reminderKey] = notifiedAt; });
    const cutoff = Date.now() - 180 * 86400000;
    Object.entries(notified).forEach(([key, value]) => {
      if (Date.parse(value) < cutoff) delete notified[key];
    });
    await fs.writeFile(reminderPath, JSON.stringify(notified, null, 2), "utf8");
  } catch (error) {
    console.error("任务到期提醒检查失败：", error);
  } finally {
    reminderCheckBusy = false;
  }
}

function startTaskReminderChecks() {
  if (process.argv.includes("--selftest")) return;
  clearInterval(reminderTimer);
  setTimeout(() => checkTaskReminders(), 3000);
  reminderTimer = setInterval(() => checkTaskReminders(), 60 * 1000);
  reminderTimer.unref?.();
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
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const recordPath = path.join(recordsDir, name);
    const record = await readJson(recordPath, null);
    if (!record) continue;
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
      record.categoryId = OTHER_CATEGORY.id;
      record.category = OTHER_CATEGORY.name;
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
  }
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
  // 自检模式（--selftest）：验证界面元素与 AI 链路，结果写入 selftest-result.json
  if (process.argv.includes("--selftest")) {
    const askIndex = process.argv.indexOf("--aichat");
    const selfTestAsk = askIndex >= 0 ? String(process.argv[askIndex + 1] || "资料库里有多少条记录？") : "";
    mainWindow.webContents.once("did-finish-load", async () => {
      const out = {};
      try {
        const ui = await mainWindow.webContents.executeJavaScript(`(async () => {
          const before = document.querySelector("#assistantPanel");
          const btn = document.querySelector("#openAssistant");
          if (btn) btn.click();
          await new Promise((resolve) => setTimeout(resolve, 150));
          const after = document.querySelector("#assistantPanel");
          return JSON.stringify({
            hasPanel: Boolean(after),
            hiddenBefore: before ? before.className.includes("hidden") : null,
            hiddenAfter: after ? after.className.includes("hidden") : null,
            suggestions: document.querySelectorAll("#assistantSuggest button").length,
            logText: after ? String(after.querySelector("#assistantLog")?.textContent || "").slice(0, 60) : "",
            navItems: [...document.querySelectorAll(".nav-item")].map((n) => n.textContent.trim()),
            hasChatApi: typeof (window.worktrace && window.worktrace.chat) === "function",
            hasImportApi: typeof (window.worktrace && window.worktrace.importFiles) === "function"
          });
        })()`);
        out.ui = JSON.parse(ui);
      } catch (error) {
        out.uiError = error.message;
      }
      if (process.argv.includes("--actionprobe")) {
        try {
          const raw = await mainWindow.webContents.executeJavaScript(`(() => {
            state.assistantHistory.push({ role: "assistant", content: "操作预览测试", actions: [{ id: "action_probe", type: "create_task", summary: "新建任务：界面预览测试", status: "pending", input: { text: "界面预览测试" } }] });
            renderAssistant();
            const card = document.querySelector(".assistant-action");
            const cancel = document.querySelector("[data-assistant-cancel]");
            const hadConfirm = Boolean(document.querySelector("[data-assistant-execute]"));
            const hadCancel = Boolean(cancel);
            if (cancel) cancel.click();
            return JSON.stringify({
              hasCard: Boolean(card),
              hasConfirm: hadConfirm,
              hasCancel: hadCancel,
              statusAfterCancel: state.assistantHistory[state.assistantHistory.length - 1].actions[0].status,
              visibleText: String(card?.textContent || "").replace(/\s+/g, " ").trim(),
            });
          })()`);
          out.actionUi = JSON.parse(raw);
        } catch (error) {
          out.actionUiError = error.message;
        }
      }
      if (process.argv.includes("--actionexecuteprobe")) {
        try {
          const raw = await mainWindow.webContents.executeJavaScript(`(async () => {
            const marker = "__工作助手确认链路测试__" + Date.now();
            const actionId = "action_execute_probe";
            const messageIndex = state.assistantHistory.length;
            const action = { id: actionId, type: "create_task", summary: "新建任务：" + marker, status: "pending", input: { text: marker, dueDate: "", projectId: "", recordIds: [] } };
            state.assistantHistory.push({ role: "assistant", content: "确认执行测试", actions: [action] });
            renderAssistant();
            document.querySelector('[data-assistant-execute="' + messageIndex + '"][data-assistant-action="' + actionId + '"]')?.click();
            const deadline = Date.now() + 5000;
            while ((action.status === "pending" || action.status === "executing") && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const tasks = await window.worktrace.listTasks();
            const created = tasks.filter((task) => task.text === marker);
            for (const task of created) await window.worktrace.deleteTask(task.id);
            return JSON.stringify({ status: action.status, created: created.length, cleaned: created.length, error: action.error || "" });
          })()`);
          out.actionExecute = JSON.parse(raw);
        } catch (error) {
          out.actionExecuteError = error.message;
        }
      }
      if (selfTestAsk) {
        try {
          const script = `(async () => {
            const s = await window.worktrace.getSettings();
            const base = { aiEnabled: s.aiEnabled, aiVerified: s.aiVerified, hasApiKey: s.hasApiKey, provider: s.provider, model: s.model, projects: (s.projects || []).length };
            try {
              const r = await window.worktrace.chat([{ role: "user", content: ${JSON.stringify(selfTestAsk)} }]);
              return JSON.stringify({
                config: base,
                reply: String(r.reply || "").slice(0, 600),
                citations: (r.citations || []).length,
                actions: (r.actions || []).map((action) => ({ type: action.type, summary: action.summary, status: action.status })),
              });
            } catch (error) {
              return JSON.stringify({ config: base, chatError: String((error && error.message) || error) });
            }
          })()`;
          out.ai = JSON.parse(await mainWindow.webContents.executeJavaScript(script));
        } catch (error) {
          out.aiError = error.message;
        }
      }
      if (process.argv.includes("--tools")) {
        try {
          const raw = await mainWindow.webContents.executeJavaScript("window.worktrace.selftestTools().then((r) => JSON.stringify(r)).catch((e) => JSON.stringify({ error: String((e && e.message) || e) }))");
          out.tools = JSON.parse(raw);
        } catch (error) {
          out.toolsError = error.message;
        }
      }
      if (process.argv.includes("--settingsprobe")) {
        try {
          const raw = await mainWindow.webContents.executeJavaScript(`(async () => {
            document.querySelector("#openSettings").click();
            await new Promise((resolve) => setTimeout(resolve, 300));
            const provider = document.querySelector("#provider");
            const model = document.querySelector("#model");
            const baseUrl = document.querySelector("#baseUrl");
            const apiKey = document.querySelector("#apiKey");
            const baseUrlRow = document.querySelector("#baseUrlRow");
            const modelOptions = document.querySelector("#modelOptions");
            return JSON.stringify({
              dialogOpen: document.querySelector("#settingsDialog").open,
              providerValue: provider ? provider.value : null,
              providerOptionCount: provider ? provider.options.length : 0,
              modelValue: model ? model.value : null,
              baseUrlValue: baseUrl ? baseUrl.value : null,
              baseUrlRowHidden: baseUrlRow ? baseUrlRow.className.includes("hidden") : null,
              apiKeyDisabled: apiKey ? apiKey.disabled : null,
              apiKeyPlaceholder: apiKey ? apiKey.placeholder : null,
              modelOptionCount: modelOptions ? modelOptions.options.length : null,
              keyHint: String((document.querySelector("#keyHint") || {}).textContent || "").slice(0, 60)
            });
          })()`);
          out.settingsProbe = JSON.parse(raw);
        } catch (error) {
          out.settingsProbeError = error.message;
        }
      }
      const keyIdx = process.argv.indexOf("--keyprobe");
      if (keyIdx >= 0) {
        try {
          const probeKey = String(process.argv[keyIdx + 1] || "sk-probe-invalid");
          const raw = await mainWindow.webContents.executeJavaScript(`window.worktrace.testAi({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: ${JSON.stringify(probeKey)}, visionEnabled: false }).then((r) => JSON.stringify({ ok: true, result: r })).catch((e) => JSON.stringify({ ok: false, error: String((e && e.message) || e) }))`);
          out.keyProbe = JSON.parse(raw);
        } catch (error) {
          out.keyProbeError = error.message;
        }
      }      try {
        fsSync.writeFileSync(path.join(__dirname, "selftest-result.json"), JSON.stringify(out, null, 2), "utf8");
      } catch (error) { }
      setTimeout(() => app.quit(), 300);
    });
  }
}

app.whenReady().then(async () => {
  const startupSettings = await loadSettingsInternal();
  if (startupSettings.libraryPath) {
    librarySyncBusy = true;
    void (async () => {
      try {
        await ensureLibrary(startupSettings.libraryPath);
        const scan = await syncSettingsFromLibraryFolders(startupSettings);
        await saveSettingsInternal(startupSettings);
        await reconcileRecordsWithSettings(startupSettings);
        mainWindow?.webContents.send("library:changed", scan);
      } catch (error) {
        console.error("资料库自动整理失败：", error);
      } finally {
        librarySyncBusy = false;
        startLibraryWatcher(startupSettings.libraryPath);
      }
    })();
  }
  createWindow();
  if (!startupSettings.libraryPath) startLibraryWatcher("");
  startTaskReminderChecks();

  ipcMain.handle("settings:get", async () => publicSettings(await loadSettingsInternal()));
  ipcMain.handle("workspace:exportBackup", exportWorkspaceBackup);
  ipcMain.handle("workspace:importBackup", importWorkspaceBackup);
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
    const scan = await syncSettingsFromLibraryFolders(settings);
    await saveSettingsInternal(settings);
    await reconcileRecordsWithSettings(settings);
    startLibraryWatcher(settings.libraryPath);
    return { ...publicSettings(settings), scan };
  });
  ipcMain.handle("settings:save", async (_event, input) => {
    const settings = await loadSettingsInternal();
    const providerKey = input.provider in PROVIDERS ? input.provider : "custom";
    const providerPreset = PROVIDERS[providerKey];
    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl || providerPreset.baseUrl);
    const normalizedModel = String(input.model || "").trim() || providerPreset.model || "";
    const normalizedKey = normalizeApiKey(input.apiKey);
    const connectionChanged = settings.provider !== providerKey
      || normalizeBaseUrl(settings.baseUrl) !== normalizedBaseUrl
      || settings.model !== normalizedModel
      || Boolean(normalizedKey);
    settings.aiEnabled = Boolean(input.aiEnabled);
    settings.visionEnabled = Boolean(input.visionEnabled);
    settings.provider = providerKey;
    settings.baseUrl = normalizedBaseUrl;
    settings.model = normalizedModel;
    settings.categoriesEnabled = input.categoriesEnabled !== false;
    const requestedCategories = withOtherCategory(normalizeCategories(input.categories));
    const categoryChanges = settings.libraryPath
      ? await applyCategoryChanges(settings.libraryPath, settings.categories, requestedCategories)
      : { categories: requestedCategories, pathChanges: [] };
    settings.categories = categoryChanges.categories;
    const existingProjects = new Map(settings.projects.map((project) => [project.id, project]));
    settings.projects = normalizeProjects((input.projects || []).map((project) => ({ ...existingProjects.get(project.id), ...project })));
    if (input.removeApiKey) {
      settings.encryptedApiKey = "";
      settings.aiVerified = false;
    } else if (normalizedKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统无法安全保存 API 密钥");
      settings.encryptedApiKey = safeStorage.encryptString(normalizedKey).toString("base64");
    }
    settings.aiVerified = Boolean(input.aiVerified) && !input.removeApiKey;
    if (connectionChanged && !input.aiVerified) settings.aiVerified = false;
    await updateRecordPathsForCategoryChanges(settings, categoryChanges.pathChanges);
    await saveSettingsInternal(settings);
    if (settings.libraryPath) await indexExistingLibraryFiles(settings);
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
      groupId: input?.groupId,
      createdAt: new Date().toISOString(),
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
    const existingProjects = new Map(settings.projects.map((project) => [project.id, project]));
    const projects = normalizeProjects((Array.isArray(input) ? input : []).map((project) => ({ ...existingProjects.get(project.id), ...project })));
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
  ipcMain.handle("projects:saveLayout", async (_event, input = {}) => {
    const settings = await loadSettingsInternal();
    const groups = normalizeProjectGroups(input.groups);
    const validGroupIds = new Set(groups.map((group) => group.id));
    const assignments = input.assignments && typeof input.assignments === "object" ? input.assignments : {};
    settings.projectGroups = groups;
    settings.projectGroupMode = ["none", "month", "custom"].includes(input.mode) ? input.mode : "none";
    settings.projects = normalizeProjects(settings.projects.map((project) => {
      const requested = String(assignments[project.id] || "");
      return { ...project, groupId: validGroupIds.has(requested) ? requested : "" };
    }));
    await saveSettingsInternal(settings);
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
    if (!settings.aiEnabled || !settings.aiVerified) throw new Error("请先在设置中保存有效的 AI 配置");
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

  const REPORT_LABELS = { daily: "日报", weekly: "周报", monthly: "月报", custom: "工作报告" };
  const REPORT_TEMPLATES = {
    daily: "一、今日完成\n二、项目进展\n三、风险与问题\n四、明日计划",
    weekly: "一、本周完成\n二、各项目进展\n三、未完成事项\n四、风险与问题\n五、下周计划",
    monthly: "一、本月主要成果\n二、项目进展与数据\n三、未完成事项\n四、风险与问题\n五、下月计划",
    custom: "一、工作总结\n二、问题与风险\n三、下一步计划",
  };
  ipcMain.handle("reports:generate", async (_event, input = {}) => {
    const settings = await loadSettingsInternal();
    const type = REPORT_LABELS[input.type] ? input.type : "daily";
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || ""))
      ? String(input.startDate)
      : new Date().toISOString().slice(0, 10);
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.endDate || ""))
      ? String(input.endDate)
      : startDate;
    if (startDate > endDate) throw new Error("报告开始日期不能晚于结束日期");
    const requestedProjects = Array.isArray(input.projectIds)
      ? input.projectIds.map((value) => String(value || "")).filter(Boolean)
      : (input.projectId ? [String(input.projectId)] : []);
    const validProjectIds = new Set(settings.projects.map((item) => item.id));
    const projectIds = new Set(requestedProjects.filter((id) => id === "__unassigned__" || validProjectIds.has(id)));
    const recordIds = new Set(Array.isArray(input.recordIds) ? input.recordIds.map((value) => String(value || "")).filter(Boolean) : []);
    const matchesProject = (record) => {
      if (!projectIds.size) return true;
      return projectIds.has(record.projectId || "__unassigned__");
    };
    const records = (await listRecords()).filter((record) => {
      // 报告周期按资料进入工作台的日期计算；文件内容里提到的事件日期
      // 可能是更早的日期，不应让当天新加入的资料从日报中消失。
      const date = String(record.createdAt || record.eventDate || "").slice(0, 10);
      if (date < startDate || date > endDate) return false;
      if (!matchesProject(record)) return false;
      return !recordIds.size || recordIds.has(record.id);
    });
    const tasks = (await listManualTasks()).filter((task) => {
      const date = String(task.dueDate || task.updatedAt || task.createdAt || "").slice(0, 10);
      if (date < startDate || date > endDate) return false;
      if (!projectIds.size) return true;
      return projectIds.has(task.projectId || "__unassigned__");
    });
    const selectedProjectNames = [...projectIds].map((id) => id === "__unassigned__"
      ? "跨项目 / 全局资料"
      : settings.projects.find((item) => item.id === id)?.name).filter(Boolean);
    const projectName = selectedProjectNames.length ? selectedProjectNames.join("、") : "全部项目";
    const sourceLines = await Promise.all(records.slice(0, 80).map(async (record, index) => {
      const project = settings.projects.find((item) => item.id === record.projectId)?.name || "跨项目 / 全局资料";
      let sourceText = record.ocrText || "";
      // Tables are mutable sources. Refresh their text at report time so a
      // report never silently uses the snapshot from the original import.
      if (SPREADSHEET_EXTENSIONS.has(record.extension) && record.storedPath) {
        try { sourceText = await extractText(record.storedPath); } catch { /* keep the last readable snapshot */ }
      }
      const text = String(sourceText).replace(/\s+/g, " ").slice(0, 1200);
      return `${index + 1}. [${record.eventDate || "无日期"}] ${record.title || record.originalName}｜项目：${project}｜摘要：${record.summary || ""}｜待办：${(record.tasks || []).join("；")}｜风险：${(record.riskNotes || []).join("；")}｜正文片段：${text}`;
    }));
    const taskLines = tasks.slice(0, 100).map((task, index) => `${index + 1}. [${task.completed ? "已完成" : "未完成"}] ${task.text}${task.dueDate ? `（截止 ${task.dueDate}）` : ""}`);
    const template = String(input.template || REPORT_TEMPLATES[type]).trim().slice(0, 10000) || REPORT_TEMPLATES[type];
    const sourceText = [`资料（${records.length} 条）：`, sourceLines.join("\n") || "（没有匹配的资料）", `任务（${tasks.length} 条）：`, taskLines.join("\n") || "（没有匹配的任务）"].join("\n");
    const provider = PROVIDERS[settings.provider] || PROVIDERS.custom;
    const aiReady = Boolean(settings.aiEnabled && settings.aiVerified && (!provider.requiresKey || decryptApiKey(settings)));
    if (aiReady) {
      const payload = await fetchAiCompletion(settings, {
        model: settings.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "你是个人工作报告整理助手。严格按照用户提供的报告模板输出，不要虚构资料中不存在的事实。" },
          { role: "user", content: `请生成${REPORT_LABELS[type]}。报告周期：${startDate} 至 ${endDate}。资料范围：${projectName}。\n\n报告模板（标题和顺序尽量保持不变）：\n${template}\n\n可用资料：\n${redactSensitive(sourceText).slice(0, 60000)}` },
        ],
      });
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) throw new Error("AI 没有返回报告内容");
      return { text: String(content).trim(), type, startDate, endDate, projectName, sourceCount: records.length, taskCount: tasks.length, aiUsed: true };
    }
    const completed = tasks.filter((task) => task.completed);
    const fallback = `${REPORT_LABELS[type]}（${startDate} 至 ${endDate}）\n范围：${projectName}\n\n${template}\n\n资料清单：\n${records.map((record) => `- ${record.eventDate || "无日期"} ${record.title || record.originalName}`).join("\n") || "- 暂无资料"}\n\n任务：\n${tasks.map((task) => `- ${task.completed ? "✓" : "○"} ${task.text}`).join("\n") || "- 暂无任务"}\n\n（当前未启用有效 AI，以上为资料清单；启用 AI 后可生成完整总结。）`;
    return { text: fallback, type, startDate, endDate, projectName, sourceCount: records.length, taskCount: tasks.length, completedTaskCount: completed.length, aiUsed: false };
  });
  // ---------- AI 能力层：读取可直接执行，写入只生成待确认方案 ----------
  const READ_ONLY_TOOLS = [
    {
      type: "function",
      function: {
        name: "search_records",
        description: "按关键词搜索资料库中的记录，匹配标题、摘要、标签、原文件名与识别出的正文。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "关键词，例如 采购合同、客户A、报销" },
            projectId: { type: "string", description: "可选，限定在某个项目内" },
            limit: { type: "integer", description: "返回条数，默认 10，最大 30" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_record",
        description: "读取一条资料的实际正文。适用于 PDF、Word、TXT、Markdown、CSV、JSON、XLSX 和 XLS；表格会包含工作表名称和当前单元格内容。recordId 来自搜索结果。",
        parameters: {
          type: "object",
          properties: {
            recordId: { type: "string", description: "资料记录编号" },
            maxChars: { type: "integer", description: "最多返回多少字符，默认 12000，最大 30000" },
          },
          required: ["recordId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_spreadsheet",
        description: "专门读取 CSV、JSON、XLSX 或 XLS 的当前内容。返回工作表或数据内容；不能读取不存在的表格。recordId 来自搜索结果。",
        parameters: {
          type: "object",
          properties: {
            recordId: { type: "string", description: "表格资料记录编号" },
            maxChars: { type: "integer", description: "最多返回多少字符，默认 16000，最大 30000" },
          },
          required: ["recordId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_projects",
        description: "列出所有项目，以及每个项目的记录数、未完成待办数、最近活动日期。",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "project_detail",
        description: "查看某个项目的详细情况：记录时间线、待办清单、责任人、时间跨度。projectId 来自 list_projects。",
        parameters: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            limit: { type: "integer", description: "最多返回记录条数，默认 20，最大 50" },
          },
          required: ["projectId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "recent_records",
        description: "按时间倒序查看最近的记录，可指定最近多少天。",
        parameters: {
          type: "object",
          properties: {
            days: { type: "integer", description: "最近多少天，默认 7" },
            limit: { type: "integer", description: "最多返回条数，默认 20" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_tasks",
        description: "查找任务，返回可用于自动关联成果文件的 taskId、sourceKind 和 recordId。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "可选，按任务文字或项目名称搜索" },
            projectId: { type: "string", description: "可选，限定项目" },
            status: { type: "string", enum: ["open", "completed", "all"], description: "默认 open" },
            limit: { type: "integer", description: "默认 30，最大 80" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "overdue_tasks",
        description: "列出所有已逾期或今天到期的待办，包含所属项目、负责人与来源资料。",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "library_stats",
        description: "资料库总体统计：记录总数、项目数、未归项目数、未完成待办数、最近 30 天新增。",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
  ];

  const ACTION_PROPOSAL_TOOLS = [
    {
      type: "function",
      function: {
        name: "propose_create_task",
        description: "提出新建任务方案。不会立即写入，必须由用户在界面确认。可同时关联项目和资料文件。",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "任务内容" },
            dueDate: { type: "string", description: "可选，YYYY-MM-DD" },
            projectId: { type: "string", description: "可选，项目编号" },
            recordIds: { type: "array", items: { type: "string" }, description: "可选，需要关联的资料编号" },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "propose_update_task",
        description: "提出修改任务方案，例如修改文字、截止日期、完成状态、项目或关联文件。不会立即写入。",
        parameters: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            sourceKind: { type: "string", enum: ["manual", "record"], description: "任务来源" },
            recordId: { type: "string", description: "sourceKind=record 时必填，表示任务来源资料" },
            text: { type: "string" },
            completed: { type: "boolean" },
            dueDate: { type: "string", description: "YYYY-MM-DD，空字符串表示清除" },
            projectId: { type: "string", description: "空字符串表示无项目" },
            recordIds: { type: "array", items: { type: "string" } },
          },
          required: ["taskId", "sourceKind"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "propose_create_project",
        description: "提出新建项目方案。不会立即写入。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            owner: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "propose_update_record",
        description: "提出修改资料标题、所属项目或记录日期的方案。不会移动、修改或删除原文件。",
        parameters: {
          type: "object",
          properties: {
            recordId: { type: "string" },
            title: { type: "string" },
            projectId: { type: "string", description: "空字符串表示跨项目资料" },
            eventDate: { type: "string", description: "YYYY-MM-DD" },
          },
          required: ["recordId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "propose_create_office_file",
        description: "提出生成 Word、Excel 或 PPT 文件的方案。必须同时填写完整正文或表格数据，用户确认后才会保存到资料库。修改既有文件时填 sourceRecordId，应生成新副本，不覆盖原件。",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["docx", "xlsx", "pptx"] },
            title: { type: "string" },
            projectId: { type: "string" },
            content: { type: "string", description: "Word/PPT 的完整内容，可用 # 标题、- 列表的简单 Markdown。Excel 可不填。" },
            sheets: {
              type: "array",
              description: "Excel 的工作表数据。",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  rows: { type: "array", items: { type: "array", items: { type: "string" } } },
                },
                required: ["name", "rows"],
              },
            },
            sourceRecordId: { type: "string", description: "可选，如果是根据既有文件修改生成副本，填原记录编号。" },
            taskId: { type: "string", description: "可选，要自动关联成果文件的任务编号。" },
            taskSourceKind: { type: "string", enum: ["manual", "record"], description: "taskId 的任务来源。" },
            taskRecordId: { type: "string", description: "taskSourceKind=record 时必填，表示任务来源文件。" },
          },
          required: ["type", "title"],
        },
      },
    },
  ];

  const ASSISTANT_TOOLS = [...READ_ONLY_TOOLS, ...ACTION_PROPOSAL_TOOLS];
  const ACTION_TOOL_NAMES = new Set(ACTION_PROPOSAL_TOOLS.map((item) => item.function.name));

  function safeActionId(value) {
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  }

  function buildProposedAction(name, args = {}, settings) {
    const actionId = `action_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const date = (value) => {
      const raw = String(value || "");
      if (!raw) return "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("日期必须使用 YYYY-MM-DD 格式");
      return raw;
    };
    const recordIds = (value) => Array.isArray(value)
      ? [...new Set(value.map(safeActionId).filter(Boolean))].slice(0, 50)
      : [];
    const validProject = (value) => {
      const id = safeActionId(value);
      if (!id) return "";
      if (!settings.projects.some((item) => item.id === id)) throw new Error("没有找到指定的项目");
      return id;
    };
    if (name === "propose_create_task") {
      const text = String(args.text || "").trim().slice(0, 300);
      if (!text) throw new Error("新任务缺少任务内容");
      const input = { text, dueDate: date(args.dueDate), projectId: validProject(args.projectId), recordIds: recordIds(args.recordIds) };
      return { id: actionId, type: "create_task", summary: `新建任务：${text}${input.dueDate ? `（截止 ${input.dueDate}）` : ""}`, input, status: "pending" };
    }
    if (name === "propose_update_task") {
      const taskId = safeActionId(args.taskId);
      const sourceKind = args.sourceKind === "record" ? "record" : "manual";
      if (!taskId) throw new Error("修改任务缺少任务编号");
      if (sourceKind === "record" && !safeActionId(args.recordId)) throw new Error("修改文件内任务时缺少来源文件");
      const changes = {};
      if (Object.hasOwn(args, "text")) changes.text = String(args.text || "").trim().slice(0, 300);
      if (Object.hasOwn(args, "completed")) changes.completed = Boolean(args.completed);
      if (Object.hasOwn(args, "dueDate")) changes.dueDate = date(args.dueDate);
      if (Object.hasOwn(args, "projectId")) changes.projectId = validProject(args.projectId);
      if (Object.hasOwn(args, "recordIds")) changes.recordIds = recordIds(args.recordIds);
      if (!Object.keys(changes).length) throw new Error("没有需要修改的任务字段");
      const input = { taskId, sourceKind, recordId: safeActionId(args.recordId), changes };
      return { id: actionId, type: "update_task", summary: `修改任务 ${taskId}：${Object.keys(changes).join("、")}`, input, status: "pending" };
    }
    if (name === "propose_create_project") {
      const projectName = String(args.name || "").trim().slice(0, 80);
      if (!projectName) throw new Error("新项目缺少名称");
      const input = {
        name: projectName,
        owner: String(args.owner || "").trim().slice(0, 60),
        aliases: Array.isArray(args.aliases) ? args.aliases.map((item) => String(item || "").trim().slice(0, 60)).filter(Boolean).slice(0, 20) : [],
      };
      return { id: actionId, type: "create_project", summary: `新建项目：${projectName}`, input, status: "pending" };
    }
    if (name === "propose_update_record") {
      const recordId = safeActionId(args.recordId);
      if (!recordId) throw new Error("修改资料缺少记录编号");
      const changes = {};
      if (Object.hasOwn(args, "title")) {
        changes.title = String(args.title || "").trim().slice(0, 120);
        if (!changes.title) throw new Error("文件标题不能为空");
      }
      if (Object.hasOwn(args, "projectId")) changes.projectId = validProject(args.projectId);
      if (Object.hasOwn(args, "eventDate")) changes.eventDate = date(args.eventDate);
      if (!Object.keys(changes).length) throw new Error("没有需要修改的资料字段");
      const input = { recordId, changes };
      return { id: actionId, type: "update_record", summary: `更新资料 ${recordId}：${Object.keys(changes).join("、")}`, input, status: "pending" };
    }
    if (name === "propose_create_office_file") {
      const type = ["docx", "xlsx", "pptx"].includes(String(args.type || "")) ? String(args.type) : "";
      const title = String(args.title || "").trim().slice(0, 120);
      if (!type || !title) throw new Error("新建 Office 文件缺少类型或名称");
      const content = String(args.content || "").trim().slice(0, 40000);
      const sheets = Array.isArray(args.sheets) ? args.sheets.slice(0, 8).flatMap((sheet, sheetIndex) => {
        const rows = Array.isArray(sheet?.rows) ? sheet.rows.slice(0, 1000).map((row) =>
          (Array.isArray(row) ? row : [row]).slice(0, 80).map((cell) => String(cell ?? "").slice(0, 5000))) : [];
        return rows.length ? [{ name: String(sheet?.name || `工作表${sheetIndex + 1}`).trim().slice(0, 31), rows }] : [];
      }) : [];
      if (type === "xlsx" && !sheets.length) throw new Error("生成 Excel 时需要提供至少一张工作表数据");
      if (type !== "xlsx" && !content) throw new Error("生成 Word 或 PPT 时需要提供完整内容");
      const sourceRecordId = safeActionId(args.sourceRecordId);
      const taskId = safeActionId(args.taskId);
      const taskSourceKind = taskId ? (args.taskSourceKind === "record" ? "record" : "manual") : "";
      const taskRecordId = safeActionId(args.taskRecordId);
      if (taskId && taskSourceKind === "record" && !taskRecordId) throw new Error("关联文件内任务时缺少来源文件");
      const input = { type, title, projectId: validProject(args.projectId), content, sheets, sourceRecordId, taskId, taskSourceKind, taskRecordId };
      const label = { docx: "Word", xlsx: "Excel", pptx: "PPT" }[type];
      const detail = taskId ? "，完成后关联回任务" : "";
      return { id: actionId, type: "create_office_file", summary: `${sourceRecordId ? "生成修改副本" : "生成"} ${label}：${title}${detail}`, input, status: "pending" };
    }
    throw new Error(`不支持的操作方案：${name}`);
  }

  const CHAT_SYSTEM_PROMPT = [
    "你是「珊莎工作留痕」应用内置的工作助手。你可以读取资料并提出写入操作方案，但写入必须由用户在界面确认后才执行。",
    "回答要求：",
    "1. 用中文，简洁、具体，先给结论再给依据。",
    "2. 先使用搜索工具找到资料，再使用 read_record 读取需要引用的实际正文；不能只凭标题或摘要假装读过文件。",
    "3. 需要回答表格问题时，必须使用 read_spreadsheet 读取当前表格内容，并说明工作表名称；如果没有价格规则，不要自行编造报价。",
    "4. 只能基于工具返回的数据回答；数据里没有的，明确说“资料库里没有找到”。",
    "5. 提到具体资料时，在句末标注记录编号，格式：【记录:<id>】",
    "6. 分析项目时，结合记录时间线、未完成待办、逾期情况给出判断与建议。",
    "7. 不要编造人名、金额、日期；调用 propose_* 工具后，只能说“已准备方案，等待确认”，不能声称已经执行。",
    "8. 用户要求创建或修改任务、项目、资料或 Office 文件时，必须调用对应 propose_* 工具，不要只给文字步骤。",
    "9. 生成 Office 文件时，必须把最终完整内容写入 content 或 sheets，不能只建空白文件。如果用户要修改既有文件，先读取原文件，再以新副本保存，不覆盖原件。",
    "10. 如果用户要求“完成这条任务”并生成文件，要在 propose_create_office_file 中填 taskId、taskSourceKind 和必要的 taskRecordId，让成果自动关联回任务。",
    "11. 需要为任务生成成果时，先用 list_tasks 查到准确的 taskId、sourceKind 和 recordId；不能凭任务文字猜编号。",
    "12. 删除资料、删除任务、移动原文件、执行系统命令不在能力范围内，直接说明需要用户手动操作。",
  ].join("\n");

  function readRecordTasks(record) {
    if (Array.isArray(record.taskItems) && record.taskItems.length) return record.taskItems;
    return (record.tasks || []).map((text, index) => ({ id: `${record.id}-task-${index + 1}`, text, completed: false }));
  }

  function recordBrief(record) {
    return {
      id: record.id,
      title: record.title || record.originalName || "未命名",
      summary: String(record.summary || "").slice(0, 200),
      tags: (record.tags || []).slice(0, 6),
      category: record.category || "",
      projectId: record.projectId || "",
      date: record.eventDate || String(record.createdAt || "").slice(0, 10),
      owners: record.owners || [],
    };
  }

  function taskBrief(task, projectName = "") {
    return {
      id: task.id,
      text: String(task.text || "").slice(0, 150),
      completed: Boolean(task.completed),
      owner: task.owner || "",
      dueDate: task.dueDate || "",
      projectName,
      recordIds: Array.isArray(task.recordIds) ? task.recordIds.slice(0, 20) : [],
    };
  }

  async function runReadTool(settings, name, args, citations) {
    const records = await listRecords();
    const projects = settings.projects || [];
    const manualTasks = await listManualTasks();
    const projectName = (id) => projects.find((item) => item.id === id)?.name || "";
    const addCitation = (record) => {
      if (record && !citations.has(record.id)) {
        citations.set(record.id, { ...recordBrief(record), projectName: projectName(record.projectId) });
      }
    };
    const sortByDate = (list) => list.slice().sort((a, b) => String(b.eventDate || b.createdAt || "").localeCompare(String(a.eventDate || a.createdAt || "")));

    const readablePath = (record) => {
      if (!record?.storedPath) throw new Error("这条记录没有可读取的原文件");
      const libraryRoot = `${path.resolve(settings.libraryPath)}${path.sep}`;
      const resolved = path.resolve(record.storedPath);
      if (!resolved.startsWith(libraryRoot)) throw new Error("原文件不在当前资料库中，已停止读取");
      return resolved;
    };

    switch (name) {
      case "search_records": {
        const query = String(args.query || "").trim().toLowerCase();
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
        const pool = args.projectId ? records.filter((record) => record.projectId === args.projectId) : records;
        const hits = [];
        for (const record of pool) {
          if (!query) {
            hits.push(record);
            if (hits.length >= limit) break;
            continue;
          }
          let searchable = record.ocrText || "";
          if (SPREADSHEET_EXTENSIONS.has(record.extension) && record.storedPath) {
            try { searchable = await extractText(readablePath(record)); } catch { /* use the saved snapshot */ }
          }
          const haystack = [record.title, record.summary, record.originalName, searchable, ...(record.tags || []), ...(record.owners || [])].join(" ").toLowerCase();
          if (haystack.includes(query)) hits.push(record);
          if (hits.length >= limit) break;
        }
        hits.forEach(addCitation);
        return { count: hits.length, records: hits.map((record) => ({ ...recordBrief(record), projectName: projectName(record.projectId) })) };
      }
      case "read_record": {
        const record = records.find((item) => item.id === String(args.recordId || ""));
        if (!record) throw new Error("没有找到这条资料");
        addCitation(record);
        const maxChars = Math.min(Math.max(Number(args.maxChars) || 12000, 1000), 30000);
        let content = record.ocrText || "";
        let refreshed = false;
        if (record.storedPath) {
          try {
            content = await extractText(readablePath(record));
            refreshed = true;
          } catch (error) {
            if (!content) throw new Error(`原文件暂时无法读取：${error.message}`);
          }
        }
        return {
          record: { ...recordBrief(record), projectName: projectName(record.projectId), originalName: record.originalName, extension: record.extension },
          refreshed,
          content: redactSensitive(String(content || "")).slice(0, maxChars) || "（文件中没有可读取的文字）",
        };
      }
      case "read_spreadsheet": {
        const record = records.find((item) => item.id === String(args.recordId || ""));
        if (!record) throw new Error("没有找到这条表格资料");
        if (!SPREADSHEET_EXTENSIONS.has(record.extension)) throw new Error("这条资料不是 CSV、JSON、XLSX 或 XLS 表格");
        addCitation(record);
        const maxChars = Math.min(Math.max(Number(args.maxChars) || 16000, 1000), 30000);
        let content = record.ocrText || "";
        if (record.storedPath) content = await extractText(readablePath(record));
        return {
          record: { ...recordBrief(record), projectName: projectName(record.projectId), originalName: record.originalName, extension: record.extension },
          content: redactSensitive(String(content || "")).slice(0, maxChars) || "（表格中没有可读取的数据）",
          note: "内容来自读取时的当前文件；表格的公式、图表和外部链接不一定能完整还原。",
        };
      }
      case "list_projects": {
        return {
          projects: projects.map((project) => {
            const own = sortByDate(records.filter((record) => record.projectId === project.id));
            const ownIds = new Set(own.map((record) => record.id));
            const openRecordTasks = own.flatMap(readRecordTasks).filter((task) => !task.completed).length;
            const openManualTasks = manualTasks.filter((task) => !task.completed && (task.projectId === project.id || (task.recordIds || []).some((id) => ownIds.has(id)))).length;
            return {
              id: project.id,
              name: project.name,
              owner: project.owner || "",
              records: own.length,
              openTasks: openRecordTasks + openManualTasks,
              lastActivity: own.length ? (own[0].eventDate || String(own[0].createdAt || "").slice(0, 10)) : "",
            };
          }),
        };
      }
      case "project_detail": {
        const project = projects.find((item) => item.id === String(args.projectId || ""));
        if (!project) throw new Error("项目不存在，请先用 list_projects 获取项目编号");
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
        const own = sortByDate(records.filter((record) => record.projectId === project.id));
        const ownIds = new Set(own.map((record) => record.id));
        own.slice(0, limit).forEach(addCitation);
        const recordTasks = own.flatMap((record) => readRecordTasks(record).map((task) => ({ ...task, record })));
        const manual = manualTasks.filter((task) => task.projectId === project.id || (task.recordIds || []).some((id) => ownIds.has(id)));
        const allTasks = [
          ...manual.map((task) => ({ ...taskBrief(task, project.name), sourceKind: "manual", recordId: "" })),
          ...recordTasks.map((task) => ({ ...taskBrief(task, project.name), sourceKind: "record", source: task.record.title || task.record.originalName, recordId: task.record.id })),
        ];
        return {
          project: { id: project.id, name: project.name, owner: project.owner || "", aliases: project.aliases || [] },
          stats: {
            records: own.length,
            firstDate: own.length ? (own[own.length - 1].eventDate || String(own[own.length - 1].createdAt || "").slice(0, 10)) : "",
            lastDate: own.length ? (own[0].eventDate || String(own[0].createdAt || "").slice(0, 10)) : "",
            openTasks: allTasks.filter((task) => !task.completed).length,
            completedTasks: allTasks.filter((task) => task.completed).length,
          },
          records: own.slice(0, limit).map((record) => ({ ...recordBrief(record), projectName: project.name })),
          tasks: allTasks.slice(0, 60),
        };
      }
      case "recent_records": {
        const days = Math.min(Math.max(Number(args.days) || 7, 1), 365);
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
        const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const list = sortByDate(records.filter((record) => String(record.eventDate || record.createdAt || "").slice(0, 10) >= since)).slice(0, limit);
        list.forEach(addCitation);
        return { since, count: list.length, records: list.map((record) => ({ ...recordBrief(record), projectName: projectName(record.projectId) })) };
      }
      case "list_tasks": {
        const query = String(args.query || "").trim().toLowerCase();
        const status = ["open", "completed", "all"].includes(String(args.status || "")) ? String(args.status) : "open";
        const projectId = String(args.projectId || "");
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 80);
        const rows = [];
        for (const record of records) {
          for (const task of readRecordTasks(record)) {
            rows.push({ ...taskBrief(task, projectName(task.projectId || record.projectId)), sourceKind: "record", recordId: record.id, source: record.title || record.originalName, projectId: task.projectId || record.projectId || "" });
          }
        }
        for (const task of manualTasks) {
          rows.push({ ...taskBrief(task, projectName(task.projectId)), sourceKind: "manual", recordId: "", source: "手工添加", projectId: task.projectId || "" });
        }
        const matching = rows.filter((task) => {
          if (status === "open" && task.completed) return false;
          if (status === "completed" && !task.completed) return false;
          if (projectId && task.projectId !== projectId) return false;
          if (!query) return true;
          return [task.text, task.projectName, task.source].join(" ").toLowerCase().includes(query);
        });
        return { count: matching.length, tasks: matching.slice(0, limit) };
      }
      case "overdue_tasks": {
        const today = new Date().toISOString().slice(0, 10);
        const rows = [];
        for (const record of records) {
          for (const task of readRecordTasks(record)) {
            rows.push({ ...taskBrief(task, projectName(record.projectId)), sourceKind: "record", source: record.title || record.originalName, recordId: record.id });
          }
        }
        for (const task of manualTasks) {
          rows.push({ ...taskBrief(task, projectName(task.projectId)), sourceKind: "manual", source: "手工添加", recordId: "" });
        }
        const due = rows.filter((task) => !task.completed && task.dueDate && task.dueDate <= today);
        return { today, count: due.length, tasks: due.slice(0, 50) };
      }
      case "library_stats": {
        const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        return {
          totalRecords: records.length,
          projects: projects.length,
          unassignedRecords: records.filter((record) => !record.projectId).length,
          openTasks: records.flatMap(readRecordTasks).filter((task) => !task.completed).length + manualTasks.filter((task) => !task.completed).length,
          newLast30Days: records.filter((record) => String(record.createdAt || "").slice(0, 10) >= since30).length,
          categories: (settings.categories || []).map((item) => item.name),
        };
      }
      default:
        throw new Error(`不支持的操作：${name}`);
    }
  }

  async function callChatCompletion(settings, messages, tools) {
    const apiKey = decryptApiKey(settings);
    const provider = PROVIDERS[settings.provider] || PROVIDERS.custom;
    if (provider.requiresKey && !apiKey) throw new Error("尚未保存 API 密钥");
    if (!settings.baseUrl || !settings.model) throw new Error("AI 接口地址或模型名称为空");
    const response = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: settings.model, messages, tools, tool_choice: "auto", temperature: 0.3 }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`AI 接口返回 ${response.status}${detail ? `：${detail.slice(0, 200)}` : ""}`);
    }
    return response.json();
  }

  async function buildPinnedChatContext(settings, context, citations) {
    const cleanIds = (input, limit) => Array.isArray(input)
      ? [...new Set(input.map((value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100)).filter(Boolean))].slice(0, limit)
      : [];
    const recordIds = cleanIds(context?.recordIds, 12);
    const projectIds = cleanIds(context?.projectIds, 6);
    if (!recordIds.length && !projectIds.length) return "";
    const availableRecords = await listRecords();
    const parts = ["用户在界面中明确选择了以下上下文。回答时优先使用这些内容；不要把未选择的同名资料混进来。"];
    for (const projectId of projectIds) {
      try {
        const detail = await runReadTool(settings, "project_detail", { projectId, limit: 30 }, citations);
        parts.push(`\n【选中的项目】\n${redactSensitive(JSON.stringify(detail))}`);
      } catch (error) {
        parts.push(`\n【选中的项目读取失败】${error.message}`);
      }
    }
    for (const recordId of recordIds) {
      try {
        const selectedRecord = availableRecords.find((record) => record.id === recordId);
        const toolName = selectedRecord && SPREADSHEET_EXTENSIONS.has(selectedRecord.extension) ? "read_spreadsheet" : "read_record";
        const detail = await runReadTool(settings, toolName, { recordId, maxChars: 6000 }, citations);
        parts.push(`\n【选中的文件，已读取正文】\n${redactSensitive(JSON.stringify(detail))}`);
      } catch (error) {
        parts.push(`\n【选中的文件读取失败】记录 ${recordId}：${error.message}`);
      }
    }
    return parts.join("\n").slice(0, 48000);
  }

  async function runChatPipeline(settings, history, context = {}) {
    const citations = new Map();
    const pendingActions = [];
    const pinnedContext = await buildPinnedChatContext(settings, context, citations);
    const messages = [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      ...(pinnedContext ? [{ role: "system", content: pinnedContext }] : []),
      ...history,
    ];
    for (let round = 0; round < 8; round += 1) {
      const payload = await callChatCompletion(settings, messages, ASSISTANT_TOOLS);
      const message = payload?.choices?.[0]?.message;
      if (!message) throw new Error("AI 未返回内容");
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!toolCalls.length) {
        return {
          reply: String(message.content || "").trim() || "（没有更多内容）",
          citations: [...citations.values()].slice(0, 12),
          actions: pendingActions,
        };
      }
      messages.push({ role: "assistant", content: message.content || "", tool_calls: toolCalls });
      for (const call of toolCalls) {
        const name = String(call?.function?.name || "");
        let args = {};
        try {
          args = JSON.parse(call?.function?.arguments || "{}");
        } catch (error) {
          args = {};
        }
        let result;
        try {
          if (ACTION_TOOL_NAMES.has(name)) {
            const action = buildProposedAction(name, args, settings);
            pendingActions.push(action);
            result = {
              status: "pending_confirmation",
              actionId: action.id,
              summary: action.summary,
            };
          } else {
            result = await runReadTool(settings, name, args, citations);
          }
        } catch (error) {
          result = { error: error.message };
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: redactSensitive(JSON.stringify(result)).slice(0, 12000) });
      }
    }
    return {
      reply: pendingActions.length
        ? "我已经准备好操作方案，请在下方确认后再执行。"
        : "我查了几轮还没得出结论，可以换个说法再问一次。",
      citations: [...citations.values()].slice(0, 12),
      actions: pendingActions,
    };
  }

  ipcMain.handle("ai:chat", async (_event, input = []) => {
    const settings = await loadSettingsInternal();
    const provider = PROVIDERS[settings.provider] || PROVIDERS.custom;
    const apiKey = decryptApiKey(settings);
    if (!settings.aiEnabled || !settings.aiVerified || (provider.requiresKey && !apiKey)) {
      throw new Error("请先在设置中启用 AI，并保存有效的 API 配置");
    }
    await ensureLibrary(settings.libraryPath);
    const historyInput = Array.isArray(input) ? input : input?.history;
    const context = Array.isArray(input) ? {} : (input?.context || {});
    const history = Array.isArray(historyInput)
      ? historyInput
        .filter((item) => item && (item.role === "user" || item.role === "assistant"))
        .map((item) => ({ role: item.role, content: String(item.content || "").trim().slice(0, 6000) }))
        .filter((item) => item.content)
        .slice(-12)
      : [];
    if (!history.length || history[history.length - 1].role !== "user") throw new Error("请先输入问题");
    return runChatPipeline(settings, history, context);
  });

  ipcMain.handle("ai:selftestTools", async () => {
    const settings = await loadSettingsInternal();
    await ensureLibrary(settings.libraryPath);
    const citations = new Map();
    const safe = async (name, args) => {
      try {
        return await runReadTool(settings, name, args, citations);
      } catch (error) {
        return { error: error.message };
      }
    };
    const projects = await safe("list_projects", {});
    const firstProject = (projects.projects || [])[0];
    return {
      stats: await safe("library_stats", {}),
      search: await safe("search_records", { query: "", limit: 3 }),
      projects,
      detail: firstProject ? await safe("project_detail", { projectId: firstProject.id, limit: 5 }) : null,
      recent: await safe("recent_records", { days: 3650, limit: 3 }),
      overdue: await safe("overdue_tasks", {}),
      citationCount: citations.size,
      writeToolAccepted: await safe("delete_records", { id: "x" }),
    };
  });
  ipcMain.handle("ai:test", async (_event, input) => {
    const current = await loadSettingsInternal();
    const providerKey = input.provider in PROVIDERS ? input.provider : "custom";
    const providerPreset = PROVIDERS[providerKey];
    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl || providerPreset.baseUrl);
    const normalizedModel = String(input.model || "").trim() || providerPreset.model || "";
    const normalizedKey = normalizeApiKey(input.apiKey);
    const settings = {
      ...current,
      aiEnabled: true,
      provider: providerKey,
      baseUrl: normalizedBaseUrl,
      model: normalizedModel,
      visionEnabled: Boolean(input.visionEnabled),
    };
    // Do not accidentally send an old provider's key when the user switches
    // provider and leaves the new key field blank.
    if (normalizedKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统无法安全保存 API 密钥");
      settings.encryptedApiKey = safeStorage.encryptString(normalizedKey).toString("base64");
    } else if (providerKey !== current.provider) {
      settings.encryptedApiKey = "";
    }
    let visionTestPath = "";
    try {
      const provider = PROVIDERS[providerKey] || PROVIDERS.custom;
      if (provider.requiresKey && !decryptApiKey(settings)) throw new Error("请填写 API Key 后再检查连接");
      const configError = aiConfigError(settings);
      if (configError) throw new Error(configError);
      if (settings.visionEnabled) {
        visionTestPath = path.join(app.getPath("temp"), `worktrace-vision-test-${Date.now()}.png`);
        await fs.writeFile(visionTestPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      }
      let userContent = "请只回复 OK，不要解释。";
      if (settings.visionEnabled) userContent = await buildVisionContent(userContent, visionTestPath);
      const payload = await fetchAiCompletion(settings, {
        model: settings.model,
        temperature: 0,
        max_tokens: 16,
        messages: [
          { role: "system", content: "你正在进行连接测试。请只回复 OK。" },
          { role: "user", content: userContent },
        ],
      });
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) throw new Error("接口已响应，但没有返回可读内容");
      return { ok: true, title: "连接成功", vision: settings.visionEnabled };
    } finally {
      if (visionTestPath) await fs.unlink(visionTestPath).catch(() => {});
    }
  });
  ipcMain.handle("tasks:list", listManualTasks);
  ipcMain.handle("tasks:reorder", async (_event, input) => {
    const entries = Array.isArray(input) ? input.slice(0, 4000) : [];
    const normalized = entries.flatMap((item) => {
      const sourceKind = item?.sourceKind === "record" ? "record" : "manual";
      const id = String(item?.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
      const recordId = String(item?.recordId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
      const sortOrder = Number(item?.sortOrder);
      if (!id || !Number.isFinite(sortOrder) || (sourceKind === "record" && !recordId)) return [];
      return [{ sourceKind, id, recordId, sortOrder: Math.max(0, Math.min(1000000, Math.round(sortOrder))) }];
    });
    if (!normalized.length) return true;

    const settings = await loadSettingsInternal();
    await ensureLibrary(settings.libraryPath);
    const manualOrder = new Map(normalized.filter((item) => item.sourceKind === "manual").map((item) => [item.id, item.sortOrder]));
    if (manualOrder.size) {
      const manualTasks = await listManualTasks();
      await saveManualTasks(settings, manualTasks.map((task) => manualOrder.has(task.id)
        ? { ...task, sortOrder: manualOrder.get(task.id) }
        : task));
    }

    const recordOrders = new Map();
    normalized.filter((item) => item.sourceKind === "record").forEach((item) => {
      const order = recordOrders.get(item.recordId) || new Map();
      order.set(item.id, item.sortOrder);
      recordOrders.set(item.recordId, order);
    });
    for (const [recordId, order] of recordOrders) {
      const recordPath = path.join(settings.libraryPath, ".worktrace", "records", `${recordId}.json`);
      const record = await readJson(recordPath, null);
      if (!record) continue;
      record.taskItems = normalizeTaskItems(record.taskItems, record.tasks, record.id).map((task) => order.has(task.id)
        ? { ...task, sortOrder: order.get(task.id) }
        : task);
      record.tasks = record.taskItems.map((task) => task.text);
      await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
    }
    return true;
  });
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
      recordIds: input?.recordIds,
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
      ...(Object.hasOwn(input, "recordIds") ? { recordIds: input.recordIds } : {}),
      ...(Object.hasOwn(input, "sortOrder") ? { sortOrder: input.sortOrder } : {}),
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
        { name: "工作资料", extensions: ["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "txt", "md", "csv", "json"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("archive:import", async (_event, input) => {
    const filePaths = Array.isArray(input) ? input : (Array.isArray(input?.filePaths) ? input.filePaths : []);
    const supplementalText = Array.isArray(input) ? "" : String(input?.supplementalText || "").trim().slice(0, 20000);
    if (!filePaths.length) return [];
    const settings = await loadSettingsInternal();
    if (!settings.moveArchiveConfirmed) {
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "确认移动并归档",
        message: "导入后，原文件将移入工作资料库",
        detail: "文件会从桌面或当前文件夹移走，放入对应的标签文件夹，不会再额外复制一份。以后修改标签时，真实文件也会同步移动。",
        buttons: ["移动并归档", "取消"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) return [];
      settings.moveArchiveConfirmed = true;
      await saveSettingsInternal(settings);
    }
    const projectId = Array.isArray(input) ? "" : String(input?.projectId || "");
    const validProjectId = projectId && settings.projects.some((item) => item.id === projectId) ? projectId : "";
    const task = async () => {
      const results = [];
      for (const filePath of filePaths) {
        const record = await importOne(filePath, supplementalText);
        if (record && validProjectId) {
          record.projectId = validProjectId;
          record.projectAssignmentSource = "manual";
          record.projectConfirmedAt = new Date().toISOString();
          await fs.writeFile(
            path.join(settings.libraryPath, ".worktrace", "records", `${record.id}.json`),
            JSON.stringify(record, null, 2),
            "utf8",
          );
        }
        results.push(record);
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
  ipcMain.handle("archive:createOfficeFile", async (_event, input) => {
    const task = () => createOfficeRecord(input);
    const queued = importQueue.then(task, task);
    importQueue = queued.catch(() => {});
    return queued;
  });
  ipcMain.handle("archive:refreshRecord", async (_event, idInput) => {
    const id = String(idInput || "");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("记录编号无效");
    const settings = await loadSettingsInternal();
    await ensureLibrary(settings.libraryPath);
    const recordPath = path.join(settings.libraryPath, ".worktrace", "records", `${id}.json`);
    const record = await readJson(recordPath, null);
    if (!record?.storedPath) throw new Error("没有找到这条记录的原文件");
    const stat = await fs.stat(record.storedPath).catch(() => null);
    if (!stat?.isFile()) throw new Error("原文件已经不存在或无法读取");
    await refreshRecordContent(record, record.storedPath, stat);
    await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
    return record;
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

    const previousRecord = { ...record };
    let nextProjectId = record.projectId || "";
    let nextEventDate = record.eventDate || record.createdAt.slice(0, 10);
    if (Object.hasOwn(input, "projectId")) {
      nextProjectId = String(input.projectId || "");
      if (nextProjectId && !settings.projects.some((item) => item.id === nextProjectId)) throw new Error("项目不存在");
    }
    if (Object.hasOwn(input, "eventDate")) {
      const eventDate = String(input.eventDate || "");
      if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new Error("日期格式无效");
      nextEventDate = eventDate || record.createdAt.slice(0, 10);
    }

    let relocatedFrom = "";
    if (Object.hasOwn(input, "projectId")) {
      record.projectId = nextProjectId;
      record.projectAssignmentSource = "manual";
      record.projectConfirmedAt = new Date().toISOString();
    }
    if (Object.hasOwn(input, "categoryId")) {
      const categoryId = String(input.categoryId || "");
      const category = settings.categories.find((item) => item.id === categoryId) || OTHER_CATEGORY;
      if (record.storedPath && category.id !== record.categoryId) {
        relocatedFrom = record.storedPath;
        record.storedPath = await moveRecordToCategory(settings.libraryPath, record.storedPath, category.name, record.originalName);
        record.archivedRelativePath = path.relative(settings.libraryPath, record.storedPath);
      }
      record.categoryId = category.id;
      record.category = category.name;
    }
    if (Object.hasOwn(input, "eventDate")) {
      record.eventDate = nextEventDate;
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
    if (Object.hasOwn(input, "title")) {
      const title = String(input.title || "").trim().slice(0, 120);
      if (!title) throw new Error("标题不能为空");
      record.title = title;
      record.titleSource = "manual";
    }
    try {
      await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
    } catch (error) {
      if (relocatedFrom && record.storedPath !== relocatedFrom) {
        const previousCategory = settings.categories.find((item) => item.id === previousRecord.categoryId) || OTHER_CATEGORY;
        await moveRecordToCategory(settings.libraryPath, record.storedPath, previousCategory.name, previousRecord.originalName).catch(() => {});
      }
      throw error;
    }
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
    try {
      const manualTasks = await listManualTasks();
      const cleanedManualTasks = manualTasks.map((task) => ({
        ...task,
        recordIds: (task.recordIds || []).filter((recordId) => recordId !== id),
      }));
      if (JSON.stringify(cleanedManualTasks) !== JSON.stringify(manualTasks)) {
        await saveManualTasks(settings, cleanedManualTasks);
      }
      const recordsDir = path.join(settings.libraryPath, ".worktrace", "records");
      const remainingNames = await fs.readdir(recordsDir).catch(() => []);
      await Promise.all(remainingNames.filter((name) => name.endsWith(".json")).map(async (name) => {
        const remainingPath = path.join(recordsDir, name);
        const remaining = await readJson(remainingPath, null);
        if (!remaining) return;
        const taskItems = taskItemsForCleanup(remaining, id);
        if (!taskItems) return;
        remaining.taskItems = taskItems;
        remaining.tasks = taskItems.map((task) => task.text);
        await fs.writeFile(remainingPath, JSON.stringify(remaining, null, 2), "utf8");
      }));
    } catch (error) {
      console.error("清理任务中的文件关联失败：", error);
    }
    return { id, originalKept: !input?.trashOriginal };
  });
  ipcMain.handle("archive:reveal", async (_event, filePath) => shell.showItemInFolder(filePath));
  ipcMain.handle("archive:open", async (_event, filePath) => {
    const settings = await loadSettingsInternal();
    const resolvedPath = path.resolve(String(filePath || ""));
    if (!settings.libraryPath || !isInside(settings.libraryPath, resolvedPath)) {
      throw new Error("原文件不在当前资料库中，无法打开");
    }
    try {
      await fs.access(resolvedPath);
    } catch {
      throw new Error("原文件已经不存在或被移动了");
    }
    const openError = await shell.openPath(resolvedPath);
    if (openError) throw new Error(`无法打开文件：${openError}`);
    return true;
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  clearInterval(reminderTimer);
  if (libraryWatcher) libraryWatcher.close();
  if (portableOcrWorker) portableOcrWorker.terminate().catch(() => {});
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ═══════════════════════════════════════════════════════════════════════════
// 智能体内核（DeepSeek Harness SDK，独立子进程）
// 「资料助手」由此从纯聊天升级为可执行智能体：读资料库、读文档正文、整理归档、
// 管理任务与项目。内核装在应用目录之外（agent-runtime），应用更新不会冲掉它。
// ═══════════════════════════════════════════════════════════════════════════
const AGENT_TOOL_LABELS = {
  worktrace_overview: '翻一下资料库',
  worktrace_search: '找资料',
  worktrace_record: '看这条资料',
  worktrace_extract: '读文件里的内容',
  worktrace_report: '写报告',
  worktrace_organize: '整理归档',
  worktrace_task: '处理任务',
  pwsh: '查一下电脑上的文件',
  str_replace_editor: '改文件',
};

const AGENT_MUTATING_TOOLS = ["worktrace_task","worktrace_organize","worktrace_report"];
const agentState = { child: null, buffer: '', nextId: 1, pending: new Map(), sessionId: '', idle: null, display: '', ready: false, mutated: false };

function agentRuntimePath() {
  const candidates = [
    process.env.WORKTRACE_AGENT_RUNTIME,
    process.resourcesPath ? path.join(process.resourcesPath, 'agent-runtime') : '',
    path.join(app.getAppPath(), '..', '..', 'agent-runtime'),
    path.join(process.env.USERPROFILE || '', 'Desktop', '留痕app', 'agent-runtime'),
  ].filter(Boolean);
  for (const dir of candidates) {
    const bin = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fsSync.existsSync(bin)) return { dir: path.resolve(dir), bin: bin };
  }
  return null;
}

let agentLogPath = '';
function agentLog(line) {
  try {
    if (!agentLogPath) agentLogPath = path.join(agentRuntimePath().dir, 'agent.log');
    fsSync.appendFileSync(agentLogPath, new Date().toISOString() + ' ' + line + '\n');
  } catch (error) {}
}

function agentEmit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:event', payload);
}

/** 模型偶尔会把同一段话原样输出两遍，这里折叠成一遍。 */
function agentCollapse(text) {
  const t = String(text || '').trim();
  const n = t.length;
  if (n < 20) return t;
  for (const sep of ['\n\n', '\n', ' ']) {
    const half = Math.floor((n - sep.length) / 2);
    if (half < 10) continue;
    const head = t.slice(0, half).trim();
    const tail = t.slice(n - half).trim();
    if (head.length > 0 && head === tail) return head;
  }
  return t;
}

function agentToolName(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.name === 'string' && AGENT_TOOL_LABELS[data.name]) return data.name;
  const found = [];
  (function walk(node, depth) {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (typeof node.name === 'string' && AGENT_TOOL_LABELS[node.name]) found.push(node.name);
    Object.keys(node).forEach((key) => { if (node[key] && typeof node[key] === 'object') walk(node[key], depth + 1); });
  })(data, 0);
  return found[0] || '';
}

function agentFrame(frame) {
  if (frame.id !== undefined && frame.method === undefined) {
    const waiter = agentState.pending.get(frame.id);
    agentState.pending.delete(frame.id);
    if (waiter) waiter(frame);
    return;
  }
  if (frame.method === 'session.status') {
    const status = (frame.params && frame.params.status) || '';
    if (status === 'running') { agentState.display = ''; agentState.mutated = false; }
    if (status === 'idle' && agentState.idle) { const done = agentState.idle; agentState.idle = null; done(); }
    return;
  }
  if (frame.method !== 'session.event') return;
  const event = (frame.params && frame.params.event) || {};
  if (event.type === 'assistant/message') {
    const texts = [];
    (function walk(node, depth) {
      if (depth > 8 || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach((item) => walk(item, depth + 1)); return; }
      if (node.type === 'text' && typeof node.text === 'string') texts.push(node.text);
      Object.keys(node).forEach((key) => walk(node[key], depth + 1));
    })(event.data, 0);
    const unique = [];
      for (const piece of texts) { if (piece && unique.indexOf(piece) < 0) unique.push(piece); }
      const text = agentCollapse(unique.join('\n\n'));
    if (text && agentState.display.indexOf(text) < 0) {
      agentState.display = agentState.display ? agentState.display + '\n\n' + text : text;
      agentEmit({ kind: 'assistant', text: agentState.display });
    }
  } else if (event.type === 'tool/call') {
    const toolName = agentToolName(event.data);
    if (AGENT_MUTATING_TOOLS.indexOf(toolName) >= 0) agentState.mutated = true;
    const label = AGENT_TOOL_LABELS[toolName] || '执行操作';
    agentState.display = (agentState.display ? agentState.display + '\n' : '') + '⚙ ' + label + '…';
    agentEmit({ kind: 'tool', text: agentState.display });
  } else if (event.type === 'turn/end') {
    const reason = event.data && event.data.reason;
    if (reason && reason.kind === 'error') agentEmit({ kind: 'error', text: '智能体执行出错：' + String((reason.error && reason.error.message) || '未知错误') });
    agentEmit({ kind: 'turnEnd', mutated: agentState.mutated });
  }
}

function agentRequest(method, params) {
  const id = agentState.nextId++;
  const payload = { jsonrpc: '2.0', id: id, method: method };
  if (params !== undefined) payload.params = params;
  agentState.child.stdin.write(JSON.stringify(payload) + '\n');
  return new Promise((resolve, reject) => {
    agentState.pending.set(id, resolve);
    setTimeout(() => { if (agentState.pending.has(id)) { agentState.pending.delete(id); reject(new Error('智能体响应超时：' + method)); } }, 300000);
  });
}

function agentStop() {
  if (agentState.child) {
    try { agentState.child.kill(); } catch (error) {}
  }
  agentState.child = null;
  agentState.ready = false;
  agentState.pending.clear();
}

async function agentEnsure(settings) {
  if (agentState.child && agentState.ready) return true;
  const runtime = agentRuntimePath();
  if (!runtime) return false;
  const apiKey = decryptApiKey(settings);
  if (!apiKey) return false;
  const nodeBin = process.execPath;
  const child = require('node:child_process').spawn(nodeBin, [runtime.bin, '--profile', 'sdk-minimal'], {
    cwd: settings.libraryPath,
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: path.join(runtime.dir, '.dsh-home'),
      DEEPSEEK_API_KEY: apiKey,
      WORKTRACE_APP_ROOT: app.getAppPath(),
      WORKTRACE_TESSDATA: path.join(app.getPath('userData'), 'tessdata'),
      WORKTRACE_LIBRARY: settings.libraryPath,
      DSH_SYSTEM_PROMPT: '你是「珊莎工作留痕」里的资料助手。用户要的是结论，不是说明。\n\n必须遵守：\n- 只给结论。不要解释、不要铺垫、不要补充背景，不要"因为/所以/这意味着/顺便说"这类延伸。\n- 默认一到两句，能一句就一句。列点最多三条，每条一行，只写事实。\n- 不要反问，不要建议，不要说"要不要我…"。\n- 说人话，不用技术词：数据、字段、记录数、条目、索引、数据库、接口、调用、工具、参数、清单、配置、归档时间。\n- 不输出文件完整路径、文件编号、英文、JSON；用户问"在哪儿"时只说文件夹名字。\n- 拿不准就说"不确定"，不要编。提到具体资料、项目或任务时，必须用「」把名字括起来（用户会点它跳转）。\n\n做事：\n- 你可以翻资料库、读文件内容（PDF、Word、Excel、图片里的字）、写报告、整理归档、管任务。\n- 要动东西之前，用一句话说清做什么，做完只说结果。\n- 用户没让你动，就只回答，不要擅自改。',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  agentState.child = child;
  agentState.buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    agentState.buffer += chunk;
    let index;
    while ((index = agentState.buffer.indexOf('\n')) >= 0) {
      const line = agentState.buffer.slice(0, index).trim();
      agentState.buffer = agentState.buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch (error) { continue; }
      agentFrame(frame);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text && text.indexOf('ExperimentalWarning') < 0) { agentLog('stderr: ' + text.slice(0, 800)); }
  });
  child.on('error', (error) => { agentLog('spawn 失败: ' + String((error && error.message) || error)); });
child.on('exit', (code) => { agentLog('子进程退出 code=' + code); agentState.ready = false; agentState.child = null; });
  agentState.sessionId = 'app-' + Date.now().toString(36);
  const init = await agentRequest('initialize', {
    cwd: settings.libraryPath,
    provider: 'deepseek-official',
    model: (settings.model && String(settings.model).indexOf('deepseek') === 0) ? settings.model : 'deepseek-flash',
  });
  if (init.error) { agentLog('initialize 失败: ' + init.error.message); throw new Error('智能体内核初始化失败：' + init.error.message); }
agentLog('initialize OK, model=' + ((settings.model && String(settings.model).indexOf('deepseek') === 0) ? settings.model : 'deepseek-flash'));
  agentState.ready = true;
  return true;
}

ipcMain.handle('agent:available', async () => {
  try {
    const settings = await loadSettingsInternal();
    if (!settings.aiEnabled || !settings.libraryPath) return false;
    if ((settings.provider || 'deepseek') !== 'deepseek') return false;
    return agentRuntimePath() !== null;
  } catch (error) { return false; }
});

ipcMain.handle('agent:send', async (_event, text) => {
  const settings = await loadSettingsInternal();
  try {
    await agentEnsure(settings);
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  const prompt = String(text || '').trim();
  if (!prompt) return { ok: false, error: '内容为空' };
  agentLog('用户提问: ' + prompt.slice(0, 120));
  agentState.display = '';
  const receipt = await agentRequest('session/prompt', { sessionId: agentState.sessionId, contentBlocks: [{ type: 'text', text: prompt }] });
  if (receipt.error) return { ok: false, error: receipt.error.message };
  await new Promise((resolve) => { agentState.idle = resolve; setTimeout(() => { agentLog('等待 idle 超时'); resolve(); }, 300000); });
  agentLog('本轮结束');
  return { ok: true };
});

ipcMain.handle('agent:reset', async () => {
  agentState.sessionId = 'app-' + Date.now().toString(36);
  return true;
});

app.on('before-quit', () => { agentStop(); });
// ═══════════════════════════════════════════════════════════════════════════
// 订单导出助手：本地化插件当独立窗口打开；选文件走 app，导出自动入库
// ═══════════════════════════════════════════════════════════════════════════
// 暂时从界面下架；保留实现便于以后放到合适位置。关闭时不注册协议、窗口和 IPC。
const ORDER_ASSISTANT_ENABLED = false;
if (ORDER_ASSISTANT_ENABLED) {
let orderAssistantWindow = null;

function orderAssistantDir() {
  return path.join(app.getAppPath(), 'src', 'renderer', 'order-assistant');
}

// 插件是 Vite 打包的 module 脚本，file:// 会被 CORS 拦；用自有协议提供，不联网也不内联。
const { protocol: orderProtocol, net: orderNet } = require('electron');
const { pathToFileURL: orderFileUrl } = require('node:url');
orderProtocol.registerSchemesAsPrivileged([{ scheme: 'order', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.whenReady().then(() => {
  orderProtocol.handle('order', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '').replace(/^plugin\//, '') || 'index.html';
    const root = orderAssistantDir();
    const full = path.normalize(path.join(root, rel));
    if (full.indexOf(root) !== 0) return new Response("forbidden", { status: 403 });
    return orderNet.fetch(orderFileUrl(full).toString());
  });
});

async function openOrderAssistant() {
  if (orderAssistantWindow && !orderAssistantWindow.isDestroyed()) { orderAssistantWindow.focus(); return true; }
  const settings = await loadSettingsInternal();
  orderAssistantWindow = new BrowserWindow({
    width: 1200,
    height: 840,
    title: '订单导出助手',
    autoHideMenuBar: true,
    backgroundColor: '#f7f5f2',
    webPreferences: {
      preload: path.join(__dirname, 'order-preload.js'),
      contextIsolation: true,
      partition: 'persist:order-assistant',
      sandbox: false,
    },
  });
  const orderSession = orderAssistantWindow.webContents.session;
  orderSession.on('will-download', (event, item) => {
    try {
      const inbox = path.join(settings.libraryPath || app.getPath('userData'), '.worktrace', 'inbox');
      fsSync.mkdirSync(inbox, { recursive: true });
      const safeName = String(item.getFilename() || '订单文档.docx').replace(/[\\/:*?"<>|]/g, '-');
      item.setSavePath(path.join(inbox, safeName));
      item.once('done', async (_e, state) => {
        if (state !== 'completed') return;
        try {
          const record = await importOne(item.getSavePath(), '来自订单导出助手');
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed', record ? record.id : '');
          if (orderAssistantWindow && !orderAssistantWindow.isDestroyed()) {
            dialog.showMessageBox(orderAssistantWindow, {
              type: 'info',
              title: '已导出并归档',
              message: (record && (record.title || record.originalName)) || safeName,
              detail: '文件已经放进资料库对应的标签文件夹，并生成了一条记录。',
              buttons: ['好'],
              noLink: true,
            });
          }
        } catch (error) { console.error('订单导出归档失败', error); }
      });
    } catch (error) { console.error('订单下载处理失败', error); }
  });
  orderAssistantWindow.on('closed', () => { orderAssistantWindow = null; });
  await orderAssistantWindow.loadURL('order://app/index.html');
  return true;
}

const orderExport = require('./order-export');

/** 扫库里可用的表格与模板（走 app 自己的记录，天然只在资料库内）*/
async function orderSources() {
  const settings = await loadSettingsInternal();
  const list = [];
  const dir = path.join(settings.libraryPath, ".worktrace", "records");
  const entries = await fs.readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = await readJson(path.join(dir, entry), null);
    if (!record || !record.storedPath) continue;
    const baseName = path.basename(record.storedPath);
    if (baseName.startsWith("~$")) continue;
    const ext = path.extname(record.storedPath).toLowerCase();
    const displayName = baseName;
    const size = record.size || 0;
    if (orderExport.SHEET_EXTENSIONS.includes(ext)) {
      if (size <= 0) continue;
      list.push({ kind: "sheet", path: record.storedPath, name: displayName, size });
    } else if (orderExport.TEMPLATE_EXTENSIONS.includes(ext)) {
      let fieldCount = 0;
      try { fieldCount = (await orderExport.readTemplateFields(record.storedPath)).length; } catch (error) { fieldCount = 0; }
      if (!fieldCount) continue;
      list.push({ kind: "template", path: record.storedPath, name: displayName, fieldCount, size });
    }
  }
  return {
    sheets: list.filter((item) => item.kind === "sheet").sort((a, b) => String(a.name).localeCompare(String(b.name))),
    templates: list.filter((item) => item.kind === "template").sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}

ipcMain.handle('order:sources', () => orderSources());
ipcMain.handle('order:inspect', async (_event, input) => {
  const sheetPath = String((input && input.sheetPath) || "");
  const templatePath = String((input && input.templatePath) || "");
  const out = { sheetNames: [], columns: [], rowCount: 0, sample: [], templateFields: [], missing: [] };
  if (sheetPath) {
    const sheet = orderExport.readSheet(sheetPath, input && input.sheetName);
    out.sheetNames = sheet.sheetNames;
    out.sheetName = sheet.sheetName;
    out.columns = sheet.columns;
    out.rowCount = sheet.rows.length;
    out.sample = sheet.rows.slice(0, 3);
  }
  if (templatePath) {
    out.templateFields = await orderExport.readTemplateFields(templatePath);
  }
  out.missing = out.templateFields.filter((field) => !out.columns.includes(field));
  return out;
});

ipcMain.handle('order:generate', async (_event, input) => {
  const settings = await loadSettingsInternal();
  const sheetPath = String((input && input.sheetPath) || "");
  const templatePath = String((input && input.templatePath) || "");
  const nameField = String((input && input.nameField) || "");
  if (!sheetPath || !templatePath) return { ok: false, error: "请先选择表格和模板" };
  const tempDir = path.join(app.getPath("temp"), "worktrace-order-" + Date.now().toString(36));
  const result = await orderExport.generateBatch({ sheetPath, templatePath, outputDir: tempDir, nameField, sheetName: input && input.sheetName });
  if (!result.ok) return result;
  const records = [];
  for (const file of result.files) {
    const record = await importOne(file, "由模板生成");
    if (record) records.push({ id: record.id, title: record.title || record.originalName, category: record.category });
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("library:changed", records.length ? records[0].id : "");
  return { ok: true, generated: records.length, missing: result.missing, records: records.slice(0, 5) };
});
ipcMain.handle('order:open', () => openOrderAssistant());
ipcMain.handle('order:pickFile', async (_event, input) => {
  const settings = await loadSettingsInternal();
  const accept = String((input && input.accept) || '');
  const exts = accept.split(',').map((s) => s.trim().replace(/^\./, '')).filter((s) => s && s.indexOf('/') < 0);
  const filters = exts.length ? [{ name: '表格与文档', extensions: exts }] : [{ name: '所有文件', extensions: ['*'] }];
  const picked = await dialog.showOpenDialog(orderAssistantWindow || mainWindow, {
    title: '从资料库里选择文件',
    defaultPath: settings.libraryPath || undefined,
    properties: ['openFile'],
    filters,
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false };
  const filePath = picked.filePaths[0];
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream';
  return { ok: true, name: path.basename(filePath), base64: buffer.toString('base64'), size: buffer.length, mime };
});
}
