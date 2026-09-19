const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { finalizeArchive, relocateArchivedFile, stageFile } = require("../src/archive-storage");

test("moves the source into a project and month archive without leaving a duplicate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-storage-"));
  try {
    const sourcePath = path.join(root, "工资条.txt");
    const libraryPath = path.join(root, "资料库");
    await fs.writeFile(sourcePath, "八月工资条", "utf8");

    const staged = await stageFile(libraryPath, sourcePath, "record-工资条.txt");
    const archived = await finalizeArchive(libraryPath, staged, "劳动合同", "2026-08", "工资条.txt");

    assert.equal(await fs.readFile(archived, "utf8"), "八月工资条");
    assert.equal(archived, path.join(libraryPath, "原始资料", "劳动合同", "2026-08", "工资条.txt"));
    await assert.rejects(fs.access(sourcePath));
    await assert.rejects(fs.access(staged));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("adds a number for duplicate names instead of overwriting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-storage-"));
  try {
    const libraryPath = path.join(root, "资料库");
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    await fs.writeFile(first, "第一份", "utf8");
    await fs.writeFile(second, "第二份", "utf8");

    const stagedFirst = await stageFile(libraryPath, first, "stage-1.txt");
    const stagedSecond = await stageFile(libraryPath, second, "stage-2.txt");
    const archivedFirst = await finalizeArchive(libraryPath, stagedFirst, "官网改版", "2026-08", "客户确认.txt");
    const archivedSecond = await finalizeArchive(libraryPath, stagedSecond, "官网改版", "2026-08", "客户确认.txt");

    assert.equal(path.basename(archivedFirst), "客户确认.txt");
    assert.equal(path.basename(archivedSecond), "客户确认 (2).txt");
    assert.equal(await fs.readFile(archivedFirst, "utf8"), "第一份");
    assert.equal(await fs.readFile(archivedSecond, "utf8"), "第二份");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("keeps both files when same-name archives happen at the same time", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-storage-"));
  try {
    const libraryPath = path.join(root, "资料库");
    const first = path.join(root, "concurrent-1.txt");
    const second = path.join(root, "concurrent-2.txt");
    await fs.writeFile(first, "A", "utf8");
    await fs.writeFile(second, "B", "utf8");
    const results = await Promise.all([
      finalizeArchive(libraryPath, first, "项目", "2026-08", "记录.txt"),
      finalizeArchive(libraryPath, second, "项目", "2026-08", "记录.txt"),
    ]);
    const contents = await Promise.all(results.map((filePath) => fs.readFile(filePath, "utf8")));
    assert.deepEqual(new Set(contents), new Set(["A", "B"]));
    assert.equal(new Set(results).size, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("relocates the real file when its project changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-storage-"));
  try {
    const libraryPath = path.join(root, "资料库");
    const sourcePath = path.join(root, "记录.pdf");
    await fs.writeFile(sourcePath, "pdf", "utf8");
    const staged = await stageFile(libraryPath, sourcePath, "stage.pdf");
    const firstPath = await finalizeArchive(libraryPath, staged, "项目A", "2026-08", "记录.pdf");
    const movedPath = await relocateArchivedFile(libraryPath, firstPath, "项目B", "2026-09", "记录.pdf");

    assert.equal(movedPath, path.join(libraryPath, "原始资料", "项目B", "2026-09", "记录.pdf"));
    assert.equal(await fs.readFile(movedPath, "utf8"), "pdf");
    await assert.rejects(fs.access(firstPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
