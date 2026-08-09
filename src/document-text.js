const fs = require("node:fs/promises");

const MAX_EXTRACTED_TEXT_LENGTH = 200000;

function cleanExtractedText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_LENGTH);
}

async function extractPdfText(filePath) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: await fs.readFile(filePath) });
  try {
    const result = await parser.getText();
    const text = cleanExtractedText(result.text);
    if (!text) throw new Error("PDF 中没有可读取的文字，可能是一份扫描件");
    return text;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocxText(filePath) {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  const text = cleanExtractedText(result.value);
  if (!text) throw new Error("Word 文档中没有可读取的文字");
  return text;
}

async function extractLegacyDocText(filePath) {
  const WordExtractor = require("word-extractor");
  const extractor = new WordExtractor();
  const document = await extractor.extract(filePath);
  const text = cleanExtractedText(document.getBody());
  if (!text) throw new Error("Word 文档中没有可读取的文字");
  return text;
}

async function extractDocumentText(filePath, extension) {
  if (extension === ".pdf") return extractPdfText(filePath);
  if (extension === ".docx") return extractDocxText(filePath);
  if (extension === ".doc") return extractLegacyDocText(filePath);
  return null;
}

module.exports = {
  cleanExtractedText,
  extractDocumentText,
  extractDocxText,
  extractLegacyDocText,
  extractPdfText,
};
