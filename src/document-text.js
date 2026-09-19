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

function extractSpreadsheetText(filePath) {
  const XLSX = require("xlsx");
  const workbook = XLSX.readFile(filePath, { cellDates: true, dense: true });
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: "\t", RS: "\n", blankrows: false });
    return `【工作表：${name}】\n${csv}`;
  });
  const text = cleanExtractedText(sheets.join("\n\n"));
  if (!text) throw new Error("表格中没有可读取的数据");
  return text;
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function extractPptxText(filePath) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, match: name.match(/^ppt\/slides\/slide(\d+)\.xml$/) }))
    .filter((item) => item.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const pages = [];
  for (const slide of slides) {
    const xml = await zip.file(slide.name).async("string");
    const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXmlText(match[1]).trim())
      .filter(Boolean);
    if (runs.length) pages.push(`【幻灯片 ${slide.match[1]}】\n${runs.join("\n")}`);
  }
  const text = cleanExtractedText(pages.join("\n\n"));
  if (!text) throw new Error("PPT 中没有可读取的文字；图片和图表内容暂不读取");
  return text;
}

async function extractDocumentText(filePath, extension) {
  if (extension === ".pdf") return extractPdfText(filePath);
  if (extension === ".docx") return extractDocxText(filePath);
  if (extension === ".doc") return extractLegacyDocText(filePath);
  if (extension === ".xlsx" || extension === ".xls") return extractSpreadsheetText(filePath);
  if (extension === ".pptx") return extractPptxText(filePath);
  return null;
}

module.exports = {
  cleanExtractedText,
  extractDocumentText,
  extractDocxText,
  extractLegacyDocText,
  extractPdfText,
  extractPptxText,
  extractSpreadsheetText,
};
