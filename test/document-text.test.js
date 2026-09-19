const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");
const { extractDocxText, extractPdfText, extractPptxText, extractSpreadsheetText } = require("../src/document-text");
const { createDocxBuffer, createPptxBuffer, createXlsxBuffer } = require("../src/office-files");

function createSimplePdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  const xref = offsets.map((offset, index) => index === 0
    ? "0000000000 65535 f "
    : `${String(offset).padStart(10, "0")} 00000 n `).join("\n");
  return Buffer.from(`${body}xref\n0 ${objects.length + 1}\n${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
}

async function createSimpleDocx(text) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body>
    </w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("extracts searchable text from PDF and DOCX files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-documents-"));
  try {
    const pdfPath = path.join(root, "meeting.pdf");
    const docxPath = path.join(root, "计划.docx");
    await fs.writeFile(pdfPath, createSimplePdf("Project Alpha meeting on Friday"));
    await fs.writeFile(docxPath, await createSimpleDocx("官网改版项目周五提交"));

    assert.match(await extractPdfText(pdfPath), /Project Alpha meeting on Friday/);
    assert.match(await extractDocxText(docxPath), /官网改版项目周五提交/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("extracts searchable text from XLSX spreadsheets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-spreadsheets-"));
  try {
    const XLSX = require("xlsx");
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["项目", "状态"], ["官网改版", "进行中"]]);
    XLSX.utils.book_append_sheet(workbook, sheet, "进度");
    const filePath = path.join(root, "进度表.xlsx");
    XLSX.writeFile(workbook, filePath);
    const text = extractSpreadsheetText(filePath);
    assert.match(text, /工作表：进度/);
    assert.match(text, /官网改版/);
    assert.match(text, /进行中/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("creates readable Word, Excel and PPT files for a task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-office-files-"));
  try {
    const title = "准备客户季度汇报";
    const docxPath = path.join(root, "任务.docx");
    const xlsxPath = path.join(root, "任务.xlsx");
    const pptxPath = path.join(root, "任务.pptx");
    await Promise.all([
      fs.writeFile(docxPath, await createDocxBuffer(title, "# 项目结论\n本周已完成客户访谈。\n- 下一步准备报价")),
      fs.writeFile(xlsxPath, createXlsxBuffer(title, [{ name: "报价", rows: [["项目", "金额"], ["咨询服务", "12000"]] }])),
      fs.writeFile(pptxPath, await createPptxBuffer(title, "本周进展\n- 完成客户访谈")),
    ]);

    assert.match(await extractDocxText(docxPath), /准备客户季度汇报/);
    assert.match(await extractDocxText(docxPath), /本周已完成客户访谈/);
    assert.match(extractSpreadsheetText(xlsxPath), /工作表：报价/);
    assert.match(extractSpreadsheetText(xlsxPath), /咨询服务\t12000/);
    assert.match(await extractPptxText(pptxPath), /幻灯片 1/);
    assert.match(await extractPptxText(pptxPath), /准备客户季度汇报/);
    assert.match(await extractPptxText(pptxPath), /完成客户访谈/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reads PPTX text in slide order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktrace-pptx-"));
  try {
    const zip = new JSZip();
    zip.file("ppt/slides/slide2.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>第二页风险</a:t></p:sld>');
    zip.file("ppt/slides/slide1.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>第一页进展</a:t><a:t>已完成</a:t></p:sld>');
    const filePath = path.join(root, "汇报.pptx");
    await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
    const text = await extractPptxText(filePath);
    assert.ok(text.indexOf("第一页进展") < text.indexOf("第二页风险"));
    assert.match(text, /已完成/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
