const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");
const { extractDocxText, extractPdfText } = require("../src/document-text");

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
