import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  convertDocumentToMarkdown,
  deriveDocumentTitle,
  DocumentConversionError,
} from '../../services/document-markdown.js';

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipFixtureEntry {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  gpFlag?: number;
  overrideUncompressedSize?: number;
}

function buildZip(entries: ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const method = entry.method ?? 8;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);
    const gpFlag = entry.gpFlag ?? 0x0800;
    const uncompSize = entry.overrideUncompressedSize ?? raw.length;

    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(gpFlag, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(uncompSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(lfh, 30);

    localParts.push(lfh, compressed);

    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(gpFlag, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(uncompSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdh, 46);

    cdParts.push(cdh);
    offset += lfh.length + compressed.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function buildDocx(parts: {
  documentXml: string;
  stylesXml?: string;
  numberingXml?: string;
  relsXml?: string;
  footnotesXml?: string;
  endnotesXml?: string;
  extraEntries?: ZipFixtureEntry[];
}): Buffer {
  const entries: ZipFixtureEntry[] = [
    { name: 'word/document.xml', data: parts.documentXml },
  ];
  if (parts.stylesXml) entries.push({ name: 'word/styles.xml', data: parts.stylesXml });
  if (parts.numberingXml) entries.push({ name: 'word/numbering.xml', data: parts.numberingXml });
  if (parts.relsXml) entries.push({ name: 'word/_rels/document.xml.rels', data: parts.relsXml });
  if (parts.footnotesXml) entries.push({ name: 'word/footnotes.xml', data: parts.footnotesXml });
  if (parts.endnotesXml) entries.push({ name: 'word/endnotes.xml', data: parts.endnotesXml });
  if (parts.extraEntries) entries.push(...parts.extraEntries);
  return buildZip(entries);
}

function buildXlsx(parts: {
  workbookXml: string;
  relsXml?: string;
  sharedStringsXml?: string;
  stylesXml?: string;
  sheets: Array<{ path: string; xml: string }>;
}): Buffer {
  const entries: ZipFixtureEntry[] = [
    { name: 'xl/workbook.xml', data: parts.workbookXml },
    ...parts.sheets.map((s) => ({ name: s.path, data: s.xml })),
  ];
  if (parts.relsXml) entries.push({ name: 'xl/_rels/workbook.xml.rels', data: parts.relsXml });
  if (parts.sharedStringsXml) entries.push({ name: 'xl/sharedStrings.xml', data: parts.sharedStringsXml });
  if (parts.stylesXml) entries.push({ name: 'xl/styles.xml', data: parts.stylesXml });
  return buildZip(entries);
}

describe('document-markdown converter', () => {
  it('derives clean titles from filenames', () => {
    expect(deriveDocumentTitle('C:\\Users\\demo\\Chính sách_2026.docx')).toBe('Chính sách_2026');
    expect(deriveDocumentTitle('...')).toBe('Untitled Document');
  });

  it('converts rich DOCX with headings, merged inline formatting, links, lists, tables, notes, and skips media', () => {
    const docx = buildDocx({
      stylesXml: `<?xml version="1.0" encoding="UTF-8"?>
        <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
          <w:style w:type="paragraph" w:styleId="CustomSub"><w:name w:val="Custom Sub"/><w:basedOn w:val="Heading2"/></w:style>
          <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
          <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>
          <w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code"/></w:style>
        </w:styles>`,
      numberingXml: `<?xml version="1.0" encoding="UTF-8"?>
        <w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:abstractNum w:abstractNumId="1">
            <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
            <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
          </w:abstractNum>
          <w:num w:numId="10"><w:abstractNumId w:val="1"/></w:num>
        </w:numbering>`,
      relsXml: `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/warranty" TargetMode="External"/>
          <Relationship Id="rIdBad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
        </Relationships>`,
      footnotesXml: `<?xml version="1.0" encoding="UTF-8"?>
        <w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t>---</w:t></w:r></w:p></w:footnote>
          <w:footnote w:id="1"><w:p><w:r><w:t>Áp dụng tại Việt Nam.</w:t></w:r></w:p></w:footnote>
        </w:footnotes>`,
      documentXml: `<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chính sách bảo hành</w:t></w:r></w:p>
            <w:p><w:pPr><w:pStyle w:val="CustomSub"/></w:pPr><w:r><w:t>Điều kiện áp dụng</w:t></w:r></w:p>
            <w:p>
              <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Khách </w:t></w:r>
              <w:r><w:rPr><w:b/></w:rPr><w:t>hàng</w:t></w:r>
              <w:r><w:t xml:space="preserve"> được </w:t></w:r>
              <w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> đổi trả </w:t></w:r>
              <w:r><w:rPr><w:strike/></w:rPr><w:t>cũ</w:t></w:r>
              <w:r><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr><w:t>RMA-30</w:t></w:r>
              <w:del><w:r><w:t>NOPE</w:t></w:r></w:del>
              <w:ins><w:r><w:t xml:space="preserve"> qua </w:t></w:r></w:ins>
              <w:hyperlink r:id="rId5"><w:r><w:t>Cổng hỗ trợ</w:t></w:r></w:hyperlink>
              <w:hyperlink r:id="rIdBad"><w:r><w:t> (an toàn)</w:t></w:r></w:hyperlink>
              <w:r><w:footnoteReference w:id="1"/></w:r>
            </w:p>
            <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="10"/></w:numPr></w:pPr><w:r><w:t>Bước một</w:t></w:r></w:p>
            <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="10"/></w:numPr></w:pPr><w:r><w:t>Chi tiết con</w:t></w:r></w:p>
            <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="10"/></w:numPr></w:pPr><w:r><w:t>Bước hai</w:t></w:r></w:p>
            <w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Giữ nguyên hóa đơn.</w:t></w:r></w:p>
            <w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t>GET /v1/warranty</w:t></w:r></w:p>
            <w:tbl>
              <w:tr>
                <w:tc><w:p><w:r><w:t>Gói</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>Thời hạn | Ghi chú</w:t></w:r></w:p></w:tc>
              </w:tr>
              <w:tr>
                <w:tc><w:p><w:r><w:t>Gold</w:t></w:r></w:p></w:tc>
                <w:tc>
                  <w:p><w:r><w:t>30 ngày</w:t></w:r></w:p>
                  <w:p><w:r><w:t>Miễn phí</w:t></w:r></w:p>
                </w:tc>
              </w:tr>
            </w:tbl>
          </w:body>
        </w:document>`,
      extraEntries: [
        { name: 'word/media/large-image.png', data: Buffer.alloc(1024 * 1024, 0x41), method: 8 },
      ],
    });

    const res = convertDocumentToMarkdown(docx, { filename: 'Chính sách bảo hành.docx' });
    expect(res.ok).toBe(true);
    expect(res.title).toBe('Chính sách bảo hành');
    expect(res.sourceFormat).toBe('docx');
    expect(res.markdown).toContain('# Chính sách bảo hành');
    expect(res.markdown).toContain('## Điều kiện áp dụng');
    expect(res.markdown).toContain('**Khách hàng** được  *đổi trả* ~~cũ~~`RMA-30` qua [Cổng hỗ trợ](https://example.com/warranty) (an toàn)[^1]');
    expect(res.markdown).not.toContain('NOPE');
    expect(res.markdown).not.toContain('javascript:');
    expect(res.markdown).toContain('1. Bước một\n  - Chi tiết con\n2. Bước hai');
    expect(res.markdown).toContain('> Giữ nguyên hóa đơn.');
    expect(res.markdown).toContain('```\nGET /v1/warranty\n```');
    expect(res.markdown).toContain('| Gói | Thời hạn \\| Ghi chú |\n| --- | --- |\n| Gold | 30 ngày<br>Miễn phí |');
    expect(res.markdown).toContain('[^1]: Áp dụng tại Việt Nam.');
  });

  it('converts multi-sheet XLSX with shared strings, dates, percentages, booleans, formulas, and hidden sheet filtering', () => {
    const xlsx = buildXlsx({
      workbookXml: `<?xml version="1.0" encoding="UTF-8"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets>
            <sheet name="Bảng giá" sheetId="1" r:id="rId1"/>
            <sheet name="Nội bộ" sheetId="2" state="hidden" r:id="rId2"/>
            <sheet name="Tồn kho" sheetId="3" r:id="rId3"/>
          </sheets>
        </workbook>`,
      relsXml: `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
          <Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/>
          <Relationship Id="rId3" Target="worksheets/sheet3.xml"/>
        </Relationships>`,
      sharedStringsXml: `<?xml version="1.0" encoding="UTF-8"?>
        <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <si><t>Sản phẩm</t></si>
          <si><r><t>Giá </t></r><r><t>(USD)</t></r><rPh><t>ruby</t></rPh></si>
          <si><t>Ngày cập nhật</t></si>
          <si><t>Giảm giá</t></si>
          <si><t>Gói A | Pro</t></si>
        </sst>`,
      stylesXml: `<?xml version="1.0" encoding="UTF-8"?>
        <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <numFmts count="1">
            <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
          </numFmts>
          <cellXfs count="3">
            <xf numFmtId="0"/>
            <xf numFmtId="164"/>
            <xf numFmtId="9"/>
          </cellXfs>
        </styleSheet>`,
      sheets: [
        {
          path: 'xl/worksheets/sheet1.xml',
          xml: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
            <sheetData>
              <row r="1">
                <c r="A1" t="s"><v>0</v></c>
                <c r="B1" t="s"><v>1</v></c>
                <c r="C1" t="s"><v>2</v></c>
                <c r="D1" t="s"><v>3</v></c>
              </row>
              <row r="2">
                <c r="A2" t="s"><v>4</v></c>
                <c r="B2"><v>19.990000000000002</v></c>
                <c r="C2" s="1"><v>45980</v></c>
                <c r="D2" s="2"><v>0.15</v></c>
              </row>
            </sheetData>
          </worksheet>`,
        },
        {
          path: 'xl/worksheets/sheet2.xml',
          xml: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SECRET</t></is></c></row></sheetData></worksheet>`,
        },
        {
          path: 'xl/worksheets/sheet3.xml',
          xml: `<worksheet><sheetData>
            <row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>Còn hàng</t></is></c><c r="C1" t="inlineStr"><is><t>Tổng</t></is></c></row>
            <row r="2"><c r="A2" t="str"><v>SKU-01</v></c><c r="B2" t="b"><v>1</v></c><c r="C2"><f>10+2</f><v>12</v></c></row>
          </sheetData></worksheet>`,
        },
      ],
    });

    const res = convertDocumentToMarkdown(xlsx, { filename: 'Bang_gia.xlsx' });
    expect(res.sourceFormat).toBe('xlsx');
    expect(res.sheetCount).toBe(2);
    expect(res.markdown).toContain('## Bảng giá');
    expect(res.markdown).toContain('| Sản phẩm | Giá (USD) | Ngày cập nhật | Giảm giá |');
    expect(res.markdown).toContain('| Gói A \\| Pro | 19.99 | 2025-11-19 | 15% |');
    expect(res.markdown).toContain('## Tồn kho');
    expect(res.markdown).toContain('| SKU-01 | TRUE | 12 |');
    expect(res.markdown).not.toContain('SECRET');
    expect(res.markdown).not.toContain('ruby');
  });

  it('converts CSV (comma and semicolon), TSV, SpreadsheetML 2003, and HTML-table Excel files', () => {
    const csv = convertDocumentToMarkdown(
      Buffer.from('Name;Note\n"Alpha; 1";"Line 1\nLine 2"', 'utf8'),
      { filename: 'catalog.csv' },
    );
    expect(csv.sourceFormat).toBe('csv');
    expect(csv.markdown).toBe('| Name | Note |\n| --- | --- |\n| Alpha; 1 | Line 1<br>Line 2 |');

    const tsv = convertDocumentToMarkdown(
      Buffer.from('Code\tPrice\nA1\t100', 'utf8'),
      { filename: 'prices.tsv' },
    );
    expect(tsv.sourceFormat).toBe('tsv');
    expect(tsv.markdown).toBe('| Code | Price |\n| --- | --- |\n| A1 | 100 |');

    const xml2003 = convertDocumentToMarkdown(
      Buffer.from(`<?xml version="1.0"?>
        <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
          <Worksheet ss:Name="Orders"><Table>
            <Row><Cell><Data ss:Type="String">ID</Data></Cell><Cell ss:Index="3"><Data ss:Type="String">Status</Data></Cell></Row>
            <Row><Cell><Data ss:Type="Number">101</Data></Cell><Cell ss:Index="3"><Data ss:Type="String">Paid</Data></Cell></Row>
          </Table></Worksheet>
        </Workbook>`, 'utf8'),
      { filename: 'orders.xls' },
    );
    expect(xml2003.sourceFormat).toBe('spreadsheetml_2003');
    expect(xml2003.markdown).toContain('## Orders');
    expect(xml2003.markdown).toContain('| ID |  | Status |\n| --- | --- | --- |\n| 101 |  | Paid |');

    const htmlXls = convertDocumentToMarkdown(
      Buffer.from('<html><body><table><tr><th>Plan</th><th>Cost</th></tr><tr><td>Pro</td><td>$10</td></tr></table></body></html>', 'utf8'),
      { filename: 'report.xls' },
    );
    expect(htmlXls.sourceFormat).toBe('html_office');
    expect(htmlXls.markdown).toBe('| Plan | Cost |\n| --- | --- |\n| Pro | $10 |');
  });

  it('rejects empty, legacy OLE2 binary, password-protected, XXE, zip-bomb, and empty-content documents safely', () => {
    expect(() => convertDocumentToMarkdown(Buffer.alloc(0), { filename: 'empty.docx' }))
      .toThrowError(DocumentConversionError);

    const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    try {
      convertDocumentToMarkdown(ole2, { filename: 'legacy.doc' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentConversionError);
      expect((err as DocumentConversionError).status).toBe(415);
      expect((err as DocumentConversionError).code).toBe('legacy_office_binary');
    }

    const encryptedOle2 = Buffer.concat([ole2, Buffer.from('EncryptedPackage', 'utf16le')]);
    try {
      convertDocumentToMarkdown(encryptedOle2, { filename: 'locked.docx' });
      expect.unreachable();
    } catch (err) {
      expect((err as DocumentConversionError).code).toBe('password_protected_document');
    }

    const encryptedZip = buildZip([{ name: 'word/document.xml', data: '<w:document/>', gpFlag: 0x0001 }]);
    try {
      convertDocumentToMarkdown(encryptedZip, { filename: 'locked-zip.docx' });
      expect.unreachable();
    } catch (err) {
      expect((err as DocumentConversionError).code).toBe('password_protected_document');
    }

    // Decompression bomb: 17 MiB of zeros deflates very small
    const bombPayload = Buffer.alloc(17 * 1024 * 1024, 0x20);
    const bombDocx = buildZip([{ name: 'word/document.xml', data: bombPayload }]);
    try {
      convertDocumentToMarkdown(bombDocx, { filename: 'bomb.docx' });
      expect.unreachable();
    } catch (err) {
      expect((err as DocumentConversionError).status).toBe(413);
      expect((err as DocumentConversionError).code).toBe('file_too_large');
    }

    // XXE declarations must never be expanded
    const xxeDocx = buildDocx({
      documentXml: `<?xml version="1.0"?>
        <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p><w:r><w:t>Safe &xxe; text</w:t></w:r></w:p></w:body>
        </w:document>`,
    });
    const xxeRes = convertDocumentToMarkdown(xxeDocx, { filename: 'xxe.docx' });
    expect(xxeRes.markdown).toBe('Safe &xxe; text');

    const emptyDocx = buildDocx({
      documentXml: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
    });
    try {
      convertDocumentToMarkdown(emptyDocx, { filename: 'blank.docx' });
      expect.unreachable();
    } catch (err) {
      expect((err as DocumentConversionError).status).toBe(422);
      expect((err as DocumentConversionError).code).toBe('empty_document');
    }
  });
});
