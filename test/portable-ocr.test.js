const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorker } = require("tesseract.js");

test("loads the bundled offline Chinese OCR model used by Windows", { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-ocr-"));
  const imagePath = path.join(root, "empty.png");
  const modelPath = require("@tesseract.js-data/chi_sim").langPath;
  let worker;
  try {
    await fs.copyFile(path.join(modelPath, "chi_sim.traineddata.gz"), path.join(root, "chi_sim.traineddata.gz"));
    await fs.writeFile(
      imagePath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    );
    worker = await createWorker("chi_sim", 1, { langPath: root });
    const result = await worker.recognize(imagePath);
    assert.equal(typeof result.data.text, "string");
  } finally {
    if (worker) await worker.terminate();
    await fs.rm(root, { recursive: true, force: true });
  }
});
