/**
 * 订单模板导出引擎（原生实现，不依赖线上插件）
 * - 读 Excel/CSV 成行列
 * - 读 Word 模板里的 {{字段}}
 * - 逐行填充生成 docx（只替换 <w:t> 文本，保持表格结构与格式）
 */
const fs = require("node:fs");
const path = require("node:path");

function requireFromApp(name) {
  const req = require("node:module").createRequire(path.join(__dirname, "..", "package.json"));
  return req(name);
}

const XLSX = requireFromApp("xlsx");
const JSZip = requireFromApp("jszip");

const SHEET_EXTENSIONS = [".xlsx", ".xls", ".csv"];
const TEMPLATE_EXTENSIONS = [".docx"];

// 只匹配真正的 <w:t> / <w:t xml:space="preserve">，绝不能写成 <w:t[^>]*>（会吃掉 <w:tblPr>）
const RUN_SOURCE = "<w:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/w:t>";
const runRegex = () => new RegExp(RUN_SOURCE, "g");

function textOfXml(xml) {
  return [...xml.matchAll(runRegex())].map((m) => m[1]).join("");
}

function fieldsOfXml(xml) {
  const found = textOfXml(xml).match(/\{\{([^{}]{1,40})\}\}/g) || [];
  return [...new Set(found.map((s) => s.slice(2, -2)))];
}

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fillXml(xml, values) {
  const used = new Set();
  const out = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
    const runs = [...paragraph.matchAll(runRegex())];
    if (!runs.length) return paragraph;
    const joined = runs.map((m) => m[1]).join("");
    if (joined.indexOf("{{") < 0) return paragraph;
    let filled = joined;
    for (const [key, value] of Object.entries(values)) {
      const token = "{{" + key + "}}";
      if (filled.indexOf(token) >= 0) {
        filled = filled.split(token).join(escapeXml(value));
        used.add(key);
      }
    }
    let first = true;
    return paragraph.replace(runRegex(), (match, inner) => {
      if (first) { first = false; return match.replace(inner, filled); }
      return match.replace(inner, "");
    });
  });
  return { xml: out, used: [...used] };
}

/** 列出工作簿里的工作表名 */
function listSheets(filePath) {
  const workbook = XLSX.read(fs.readFileSync(filePath), { type: "buffer", cellDates: true });
  return workbook.SheetNames;
}

/** 读一张表 → { columns, rows } */
function readSheet(filePath, sheetName) {
  const workbook = XLSX.read(fs.readFileSync(filePath), { type: "buffer", cellDates: true });
  const name = sheetName && workbook.SheetNames.includes(sheetName) ? sheetName : workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: "", raw: false });
  const columns = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return { sheetName: name, sheetNames: workbook.SheetNames, columns, rows };
}

/** 读模板里的 {{字段}}（含页眉页脚） */
async function readTemplateFields(templatePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const fields = [];
  for (const part of Object.keys(zip.files)) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(part)) continue;
    for (const field of fieldsOfXml(await zip.file(part).async("string"))) {
      if (!fields.includes(field)) fields.push(field);
    }
  }
  return fields;
}

/** 用一行数据填模板，写出一个 docx */
async function fillTemplate(templatePath, row, outPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const used = new Set();
  for (const part of Object.keys(zip.files)) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(part)) continue;
    const { xml, used: partUsed } = fillXml(await zip.file(part).async("string"), row);
    partUsed.forEach((key) => used.add(key));
    zip.file(part, xml);
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(outPath, buffer);
  return { path: outPath, bytes: buffer.length, used: [...used] };
}

/** 文件名安全化并保证不覆盖 */
function safeFileName(value, fallback) {
  const cleaned = String(value == null ? "" : value).replace(/[\\/:*?"<>|\r\n\t]/g, "-").trim().slice(0, 80);
  return cleaned || fallback;
}

function uniquePath(dir, baseName, extension) {
  let candidate = path.join(dir, baseName + extension);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, baseName + " (" + index + ")" + extension);
    index += 1;
    if (index > 200) break;
  }
  return candidate;
}

/**
 * 批量生成：每行一个文档
 * @returns {{ ok: boolean, files: string[], used: string[], missing: string[], error?: string }}
 */
async function generateBatch(options) {
  const sheetPath = options.sheetPath;
  const templatePath = options.templatePath;
  const outputDir = options.outputDir;
  const nameField = String(options.nameField || "").trim();
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.min(options.limit, 2000) : 2000;
  fs.mkdirSync(outputDir, { recursive: true });

  const { columns, rows } = readSheet(sheetPath, options.sheetName);
  if (!rows.length) return { ok: false, files: [], used: [], missing: [], error: "表格里没有数据行" };

  const templateFields = await readTemplateFields(templatePath);
  const missing = templateFields.filter((field) => !columns.includes(field));

  const targets = Array.isArray(options.rowIndexes) && options.rowIndexes.length
    ? options.rowIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < rows.length)
    : rows.map((_row, index) => index);

  const files = [];
  const usedAll = new Set();
  for (const index of targets.slice(0, limit)) {
    const row = rows[index];
    const baseName = safeFileName(nameField ? row[nameField] : "", "");
    const fallback = safeFileName(path.basename(templatePath, path.extname(templatePath)), "导出文档") + "-" + (index + 1);
    const outPath = uniquePath(outputDir, baseName || fallback, ".docx");
    const result = await fillTemplate(templatePath, row, outPath);
    result.used.forEach((key) => usedAll.add(key));
    files.push(outPath);
  }
  return { ok: true, files, used: [...usedAll], missing, rowCount: rows.length, generated: files.length };
}

module.exports = { listSheets, readSheet, readTemplateFields, fillTemplate, generateBatch, SHEET_EXTENSIONS, TEMPLATE_EXTENSIONS };