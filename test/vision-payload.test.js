const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildVisionContent } = require("../src/vision-payload");

test("builds an OpenAI-compatible request containing both OCR text and the image", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-vision-"));
  try {
    const imagePath = path.join(root, "截图.png");
    await fs.writeFile(imagePath, Buffer.from("image-bytes"));
    const content = await buildVisionContent("OCR 识别文字", imagePath);
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, /OCR 识别文字/);
    assert.equal(content[1].type, "image_url");
    assert.equal(content[1].image_url.url, `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
