const fs = require("node:fs/promises");
const path = require("node:path");

const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

async function buildVisionContent(prompt, imagePath) {
  const extension = path.extname(imagePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[extension];
  if (!mimeType) throw new Error("这个图片格式暂不支持发送给视觉模型");
  const imageBase64 = (await fs.readFile(imagePath)).toString("base64");
  return [
    { type: "text", text: `${prompt}\n请同时查看图片中的版式、图形、表格、界面状态和非文字信息，不要只依赖 OCR 文字。` },
    { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
  ];
}

module.exports = { IMAGE_MIME_TYPES, buildVisionContent };
