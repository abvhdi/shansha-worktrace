const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { finalizeArchive, stageFile } = require("../src/archive-storage");

test("copies the source and archives its duplicate under a stable year and month path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-storage-"));
  try {
    const sourcePath = path.join(root, "工资条.txt");
    const libraryPath = path.join(root, "资料库");
    await fs.writeFile(sourcePath, "八月工资条", "utf8");

    const staged = await stageFile(libraryPath, sourcePath, "record-工资条.txt");
    const archived = await finalizeArchive(libraryPath, staged, "2026", "08", "record-工资条.txt");

    assert.equal(await fs.readFile(sourcePath, "utf8"), "八月工资条");
    assert.equal(await fs.readFile(archived, "utf8"), "八月工资条");
    assert.equal(archived, path.join(libraryPath, "原始资料", "2026", "08", "record-工资条.txt"));
    await assert.rejects(fs.access(staged));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
