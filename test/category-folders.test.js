const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  applyCategoryChanges,
  categoriesFromFolders,
  discoverCategoryFolders,
  moveRecordToCategory,
  replacePathPrefix,
  scanCategoryFiles,
} = require("../src/category-folders");

test("discovers first-level folders as categories and always keeps 其他", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-folders-"));
  try {
    await Promise.all([fs.mkdir(path.join(root, "客户沟通")), fs.mkdir(path.join(root, "合同材料")), fs.mkdir(path.join(root, ".worktrace"))]);
    const categories = categoriesFromFolders(await discoverCategoryFolders(root));
    assert.deepEqual(categories.map((item) => item.name), ["合同材料", "客户沟通", "其他"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("renames a category folder and updates paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-folders-"));
  try {
    const oldFolder = path.join(root, "合同材料");
    const oldFile = path.join(oldFolder, "劳动合同.pdf");
    await fs.mkdir(oldFolder);
    await fs.writeFile(oldFile, "pdf");
    const result = await applyCategoryChanges(root, [{ id: "contract", name: "合同材料" }, { id: "other", name: "其他" }], [{ id: "contract", name: "权益材料" }, { id: "other", name: "其他" }]);
    const changed = replacePathPrefix(oldFile, result.pathChanges);
    assert.equal(changed.path, path.join(root, "权益材料", "劳动合同.pdf"));
    assert.equal(await fs.readFile(changed.path, "utf8"), "pdf");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deleting a category safely moves its folder under 其他", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-folders-"));
  try {
    const oldFolder = path.join(root, "旧标签");
    const oldFile = path.join(oldFolder, "记录.txt");
    await fs.mkdir(oldFolder);
    await fs.writeFile(oldFile, "记录");
    const result = await applyCategoryChanges(root, [{ id: "old", name: "旧标签" }, { id: "other", name: "其他" }], [{ id: "other", name: "其他" }]);
    const changed = replacePathPrefix(oldFile, result.pathChanges);
    assert.equal(changed.categoryId, "other");
    assert.equal(await fs.readFile(changed.path, "utf8"), "记录");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("changing a record category moves the real file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-folders-"));
  try {
    const sourceFolder = path.join(root, "其他");
    await fs.mkdir(sourceFolder);
    const source = path.join(sourceFolder, "记录.txt");
    await fs.writeFile(source, "内容");
    const moved = await moveRecordToCategory(root, source, "客户沟通", "记录.txt");
    assert.equal(moved, path.join(root, "客户沟通", "记录.txt"));
    assert.equal(await fs.readFile(moved, "utf8"), "内容");
    await assert.rejects(fs.access(source));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scans files recursively and maps root files to 其他", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-folders-"));
  try {
    await fs.mkdir(path.join(root, "客户沟通", "甲方"), { recursive: true });
    await fs.mkdir(path.join(root, "其他"));
    await fs.writeFile(path.join(root, "客户沟通", "甲方", "确认.docx"), "docx");
    await fs.writeFile(path.join(root, "桌面记录.txt"), "text");
    const files = await scanCategoryFiles(root, [{ id: "chat", name: "客户沟通" }, { id: "other", name: "其他" }]);
    assert.deepEqual(new Set(files.map((item) => `${item.category}:${path.basename(item.filePath)}`)), new Set(["客户沟通:确认.docx", "其他:桌面记录.txt"]));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
