const fs = require("node:fs/promises");
const path = require("node:path");

async function stageFile(libraryPath, sourcePath, storedName) {
  const inboxDir = path.join(libraryPath, ".worktrace", "inbox");
  const inboxPath = path.join(inboxDir, storedName);
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.copyFile(sourcePath, inboxPath);
  return inboxPath;
}

async function finalizeArchive(libraryPath, inboxPath, year, month, storedName) {
  const destinationDir = path.join(libraryPath, "原始资料", year, month);
  const storedPath = path.join(destinationDir, storedName);
  await fs.mkdir(destinationDir, { recursive: true });
  await fs.rename(inboxPath, storedPath);
  return storedPath;
}

module.exports = { finalizeArchive, stageFile };
