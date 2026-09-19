const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { moveFileVerified, uniquePath } = require("./archive-storage");

const OTHER_CATEGORY = { id: "other", name: "其他" };
const RESERVED_FOLDERS = new Set([".worktrace", "导出文件", "原始资料"]);

function safeFolderName(value) {
  const name = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "")
    .slice(0, 80);
  if (!name || RESERVED_FOLDERS.has(name)) throw new Error(`不能使用文件夹名称：${name || "空名称"}`);
  return name;
}

function categoryIdForName(name) {
  return `folder-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 10)}`;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function discoverCategoryFolders(libraryPath) {
  const entries = await fs.readdir(libraryPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !RESERVED_FOLDERS.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function categoriesFromFolders(folderNames, existingCategories = []) {
  const byName = new Map(existingCategories.map((item) => [item.name, item]));
  const categories = folderNames.filter((name) => name !== OTHER_CATEGORY.name).map((name) => ({
    id: byName.get(name)?.id || categoryIdForName(name),
    name,
  }));
  return [...categories, { ...OTHER_CATEGORY }];
}

async function ensureCategoryFolders(libraryPath, categories) {
  await fs.mkdir(path.join(libraryPath, OTHER_CATEGORY.name), { recursive: true });
  await Promise.all(categories.filter((item) => item.id !== OTHER_CATEGORY.id).map((item) =>
    fs.mkdir(path.join(libraryPath, safeFolderName(item.name)), { recursive: true }),
  ));
}

async function applyCategoryChanges(libraryPath, previousCategories, requestedCategories) {
  const next = requestedCategories.filter((item) => item.id !== OTHER_CATEGORY.id).map((item) => ({
    id: item.id,
    name: safeFolderName(item.name),
  }));
  const names = new Set();
  for (const category of next) {
    const key = process.platform === "win32" ? category.name.toLowerCase() : category.name;
    if (names.has(key) || category.name === OTHER_CATEGORY.name) throw new Error(`标签名称重复：${category.name}`);
    names.add(key);
  }
  const normalizedNext = [...next, { ...OTHER_CATEGORY }];
  const nextById = new Map(normalizedNext.map((item) => [item.id, item]));
  const pathChanges = [];
  await fs.mkdir(path.join(libraryPath, OTHER_CATEGORY.name), { recursive: true });

  for (const previous of previousCategories) {
    if (previous.id === OTHER_CATEGORY.id) continue;
    const oldFolder = path.join(libraryPath, previous.name);
    if (!(await exists(oldFolder))) continue;
    const current = nextById.get(previous.id);
    if (!current) {
      const otherFolder = path.join(libraryPath, OTHER_CATEGORY.name);
      const destination = await uniquePath(otherFolder, previous.name);
      await fs.rename(oldFolder, destination);
      pathChanges.push({ from: oldFolder, to: destination, categoryId: OTHER_CATEGORY.id, category: OTHER_CATEGORY.name });
      continue;
    }
    if (current.name !== previous.name) {
      const newFolder = path.join(libraryPath, current.name);
      if (await exists(newFolder)) throw new Error(`本地已经有“${current.name}”文件夹，请换一个标签名称`);
      await fs.rename(oldFolder, newFolder);
      pathChanges.push({ from: oldFolder, to: newFolder, categoryId: current.id, category: current.name });
    }
  }

  await ensureCategoryFolders(libraryPath, normalizedNext);
  return { categories: normalizedNext, pathChanges };
}

function replacePathPrefix(filePath, changes) {
  const resolved = path.resolve(filePath || "");
  for (const change of changes) {
    const source = path.resolve(change.from);
    if (resolved === source || resolved.startsWith(`${source}${path.sep}`)) {
      return { ...change, path: path.join(change.to, path.relative(source, resolved)) };
    }
  }
  return null;
}

async function moveRecordToCategory(libraryPath, currentPath, categoryName, originalName) {
  const source = path.resolve(currentPath);
  const libraryRoot = `${path.resolve(libraryPath)}${path.sep}`;
  if (!source.startsWith(libraryRoot)) throw new Error("原文件不在当前工作文件夹中，已停止移动");
  const targetFolder = path.join(libraryPath, safeFolderName(categoryName || OTHER_CATEGORY.name));
  await fs.mkdir(targetFolder, { recursive: true });
  if (path.dirname(source) === targetFolder) return source;
  const destination = await uniquePath(targetFolder, originalName || path.basename(source));
  return moveFileVerified(source, destination);
}

async function archiveFileToCategory(libraryPath, sourcePath, categoryName, originalName) {
  const targetFolder = path.join(libraryPath, safeFolderName(categoryName || OTHER_CATEGORY.name));
  await fs.mkdir(targetFolder, { recursive: true });
  const destination = await uniquePath(targetFolder, originalName || path.basename(sourcePath));
  return moveFileVerified(sourcePath, destination);
}

async function walkFiles(rootPath) {
  const files = [];
  const visit = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name.startsWith(".~")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  await visit(rootPath);
  return files;
}

async function scanCategoryFiles(libraryPath, categories) {
  const results = [];
  for (const category of categories) {
    const folder = path.join(libraryPath, category.name);
    if (!(await exists(folder))) continue;
    for (const filePath of await walkFiles(folder)) results.push({ filePath, categoryId: category.id, category: category.name });
  }
  const rootEntries = await fs.readdir(libraryPath, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name !== ".DS_Store") {
      results.push({ filePath: path.join(libraryPath, entry.name), categoryId: OTHER_CATEGORY.id, category: OTHER_CATEGORY.name });
    }
  }
  return results;
}

module.exports = {
  OTHER_CATEGORY,
  RESERVED_FOLDERS,
  applyCategoryChanges,
  archiveFileToCategory,
  categoriesFromFolders,
  discoverCategoryFolders,
  ensureCategoryFolders,
  moveRecordToCategory,
  replacePathPrefix,
  safeFolderName,
  scanCategoryFiles,
};
