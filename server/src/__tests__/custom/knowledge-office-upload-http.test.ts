import zlib from 'node:zlib';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { resetKnowledgeIndexes } from '../../services/profile-knowledge.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';

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

function buildZip(entries: Array<{ name: string; data: string | Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const compressed = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);

    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(lfh, 30);
    localParts.push(lfh, compressed);

    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
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

function makeSampleDocx(): Buffer {
  return buildZip([
    {
      name: 'word/styles.xml',
      data: `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
      </w:styles>`,
    },
    {
      name: 'word/document.xml',
      data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chính sách hoàn tiền</w:t></w:r></w:p>
          <w:p><w:r><w:t>Khách hàng được hoàn tiền trong vòng 30 ngày kể từ ngày nhận hàng.</w:t></w:r></w:p>
        </w:body>
      </w:document>`,
    },
  ]);
}

function makeSampleXlsx(): Buffer {
  return buildZip([
    {
      name: 'xl/workbook.xml',
      data: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="Bảng giá" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
      </Relationships>`,
    },
    {
      name: 'xl/sharedStrings.xml',
      data: `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <si><t>Gói dịch vụ</t></si>
        <si><t>Giá tháng</t></si>
        <si><t>Enterprise</t></si>
      </sst>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
          <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>499000</v></c></row>
        </sheetData>
      </worksheet>`,
    },
  ]);
}

describe('RAG knowledge Office-to-Markdown HTTP upload endpoints', () => {
  let server: Server;
  let base: string;
  let ownerToken: string;
  let memberToken: string;
  let viewerToken: string;
  let editorToken: string;
  let profileId: number;
  let tenantId: number;

  async function postJson(path: string, token: string | undefined, body: unknown, method = 'POST') {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  }

  async function uploadFile(path: string, token: string | undefined, buffer: Buffer, filename: string, mime: string) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), filename);
    form.append('filename', filename);
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    resetKnowledgeIndexes();
    setEnabled(true);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const owner = createUser('owner@kb-office.test', 'OwnerPass123!');
    ownerToken = createSession(owner.userId);

    const member = createUser('member@kb-office.test', 'MemberPass123!', 'member');
    memberToken = createSession(member.userId);

    const viewer = createUser('viewer@kb-office.test', 'ViewerPass123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway']), viewer.userId);
    viewerToken = createSession(viewer.userId);

    const editor = createUser('editor@kb-office.test', 'EditorPass123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), editor.userId);
    editorToken = createSession(editor.userId);

    const createdProfile = await postJson('/api/client-profiles', ownerToken, {
      name: 'Office RAG Profile',
      systemPrompt: 'Support bot.',
    });
    profileId = createdProfile.body.id;

    tenantId = createSupportTenant({
      name: 'Office RAG Tenant',
      defaultModel: 'test-model',
      allowedOrigins: ['https://example.com'],
      allowGuest: true,
    }).tenant.id;
  });

  afterAll(() => {
    server?.close();
  });

  it('enforces auth and RBAC permissions across all three convert endpoints', async () => {
    const docx = makeSampleDocx();
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    expect((await uploadFile(`/api/client-profiles/${profileId}/knowledge/convert`, undefined, docx, 'a.docx', mime)).status).toBe(401);
    expect((await uploadFile(`/api/client-profiles/${profileId}/knowledge/convert`, memberToken, docx, 'a.docx', mime)).status).toBe(403);
    expect((await uploadFile(`/api/thruline/support/tenants/${tenantId}/knowledge-library/convert`, viewerToken, docx, 'a.docx', mime)).status).toBe(403);
    expect((await uploadFile(`/api/thruline/support/tenants/${tenantId}/knowledge/convert`, viewerToken, docx, 'a.docx', mime)).status).toBe(403);
  });

  it('converts XLSX and DOCX uploads to Markdown and ingests them into Profile KB search', async () => {
    const xlsxRes = await uploadFile(
      `/api/client-profiles/${profileId}/knowledge/convert`,
      ownerToken,
      makeSampleXlsx(),
      'Bảng giá dịch vụ 2026.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(xlsxRes.status).toBe(200);
    expect(xlsxRes.body).toMatchObject({
      ok: true,
      title: 'Bảng giá dịch vụ 2026',
      format: 'markdown',
      sourceFormat: 'xlsx',
      sheetCount: 1,
    });
    expect(xlsxRes.body.markdown).toContain('## Bảng giá');
    expect(xlsxRes.body.markdown).toContain('| Enterprise | 499000 |');

    const added = await postJson(`/api/client-profiles/${profileId}/knowledge`, ownerToken, {
      title: xlsxRes.body.title,
      content: xlsxRes.body.markdown,
    });
    expect(added.status).toBe(201);

    const search = await fetch(`${base}/api/client-profiles/${profileId}/knowledge/search?q=Enterprise`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    }).then((r) => r.json() as Promise<any>);
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0].text).toContain('| Enterprise | 499000 |');
  });

  it('converts DOCX upload into Support Knowledge Library markdown source and retrieves heading-aware evidence', async () => {
    const conv = await uploadFile(
      `/api/thruline/support/tenants/${tenantId}/knowledge-library/convert`,
      editorToken,
      makeSampleDocx(),
      'Chính sách hoàn tiền.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(conv.status).toBe(200);
    expect(conv.body.sourceFormat).toBe('docx');
    expect(conv.body.markdown).toContain('# Chính sách hoàn tiền');

    const src = await postJson(
      `/api/thruline/support/tenants/${tenantId}/knowledge-library/sources`,
      editorToken,
      { name: conv.body.title, kind: 'markdown', allowedRoles: ['customer'] },
    );
    expect(src.status).toBe(201);

    const rev = await postJson(
      `/api/thruline/support/tenants/${tenantId}/knowledge-library/sources/${src.body.source.id}/revisions`,
      editorToken,
      {
        expectedVersion: src.body.source.version,
        title: conv.body.title,
        format: 'markdown',
        content: conv.body.markdown,
      },
    );
    expect(rev.status).toBe(201);

    const pub = await postJson(
      `/api/thruline/support/tenants/${tenantId}/knowledge-library/sources/${src.body.source.id}/publish`,
      editorToken,
      { expectedVersion: rev.body.source.version, revisionId: rev.body.revision.id },
    );
    expect(pub.status).toBe(200);

    const preview = await postJson(
      `/api/thruline/support/tenants/${tenantId}/knowledge-library/preview`,
      editorToken,
      { query: 'hoàn tiền 30 ngày', role: 'customer' },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.preview.willAbstain).toBe(false);
    expect(preview.body.preview.candidates[0].excerpt).toContain('# Chính sách hoàn tiền');
  });

  it('converts XLSX upload into Support Enterprise Knowledge Base and matches search queries', async () => {
    const conv = await uploadFile(
      `/api/thruline/support/tenants/${tenantId}/knowledge/convert`,
      editorToken,
      makeSampleXlsx(),
      'Pricing.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(conv.status).toBe(200);

    const saved = await postJson(
      `/api/thruline/support/tenants/${tenantId}/knowledge`,
      editorToken,
      { title: conv.body.title, allowedRoles: ['customer'], content: conv.body.markdown },
    );
    expect(saved.status).toBe(201);

    const search = await postJson(
      `/api/thruline/support/tenants/${tenantId}/knowledge/search`,
      editorToken,
      { query: 'Enterprise 499000', role: 'customer' },
    );
    expect(search.status).toBe(200);
    expect(search.body.matches.length).toBeGreaterThan(0);
    expect(search.body.matches[0].snippet).toContain('Enterprise');
  });

  it('returns clear 400/415 errors for missing file and legacy binary Office documents', async () => {
    const missing = await postJson(`/api/client-profiles/${profileId}/knowledge/convert`, ownerToken, {});
    expect(missing.status).toBe(400);

    const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    const legacyRes = await uploadFile(
      `/api/client-profiles/${profileId}/knowledge/convert`,
      ownerToken,
      ole2,
      'old.doc',
      'application/msword',
    );
    expect(legacyRes.status).toBe(415);
    expect(legacyRes.body.error.code).toBe('legacy_office_binary');
  });
});
