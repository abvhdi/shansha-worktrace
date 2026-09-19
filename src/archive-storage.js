const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

function safeSegment(value, fallback) {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "")
    .slice(0, 80);
  return cleaned || fallback;
}

async function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniquePath(directory, filename) {
  const parsed = path.parse(safeSegment(filename, "未命名文件"));
  let candidate = path.join(directory, `${parsed.name}${parsed.ext}`);
  let index = 2;
  while (await exists(candidate)) {
    candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

async function moveFileVerified(sourcePath, destinationPath) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) return destination;

  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.link(source, destination);
  } catch (error) {
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) throw error;
    return copyThenRemoveVerified(source, destination);
  }
  try {
    await fs.unlink(source);
    return destination;
  } catch (error) {
    await fs.unlink(destination).catch(() => {});
    throw error;
  }
}

async function copyThenRemoveVerified(source, destination) {
  // 跨磁盘时先复制并校验，确认完整后才删除源文件。
  await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  try {
    const [sourceStat, destinationStat, sourceHash, destinationHash] = await Promise.all([
      fs.stat(source),
      fs.stat(destination),
      fileHash(source),
      fileHash(destination),
    ]);
    if (sourceStat.size !== destinationStat.size || sourceHash !== destinationHash) {
      throw new Error("跨磁盘复制校验失败，原文件仍保留在原位置");
    }
    await fs.unlink(source);
    return destination;
  } catch (error) {
    await fs.unlink(destination).catch(() => {});
    throw error;
  }
}

async function stageFile(libraryPath, sourcePath, storedName) {
  const inboxDir = path.join(libraryPath, ".worktrace", "inbox");
  await fs.mkdir(inboxDir, { recursive: true });
  for (;;) {
    const inboxPath = await uniquePath(inboxDir, storedName);
    try {
      return await moveFileVerified(sourcePath, inboxPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

async function archiveDestination(libraryPath, projectName, yearMonth, originalName) {
  const projectFolder = safeSegment(projectName, "未归属项目");
  const monthFolder = /^\d{4}-\d{2}$/.test(String(yearMonth || "")) ? yearMonth : "日期待确认";
  const destinationDir = path.join(libraryPath, "原始资料", projectFolder, monthFolder);
  await fs.mkdir(destinationDir, { recursive: true });
  return uniquePath(destinationDir, originalName);
}

async function finalizeArchive(libraryPath, inboxPath, projectName, yearMonth, originalName) {
  for (;;) {
    const storedPath = await archiveDestination(libraryPath, projectName, yearMonth, originalName);
    try {
      return await moveFileVerified(inboxPath, storedPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

async function relocateArchivedFile(libraryPath, currentPath, projectName, yearMonth, originalName) {
  const libraryRoot = `${path.resolve(libraryPath)}${path.sep}`;
  const source = path.resolve(currentPath);
  if (!source.startsWith(libraryRoot)) throw new Error("原文件不在当前资料库中，已停止移动");

  for (;;) {
    const destination = await archiveDestination(libraryPath, projectName, yearMonth, originalName);
    if (path.dirname(source) === path.dirname(destination)) return source;
    try {
      return await moveFileVerified(source, destination);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

module.exports = {
  archiveDestination,
  fileHash,
  finalizeArchive,
  moveFileVerified,
  relocateArchivedFile,
  stageFile,
  uniquePath,
};
