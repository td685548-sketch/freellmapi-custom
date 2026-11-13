import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), blob: vi.fn(), container: vi.fn(), credential: vi.fn(), service: vi.fn() }));
vi.mock('@azure/storage-blob', () => ({ BlobServiceClient: class {
  constructor(...args: unknown[]) { mocks.service(...args); }
  getContainerClient = mocks.container;
} }));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {
  constructor() { mocks.credential(); }
} }));
vi.mock('../../lib/crypto.js', () => ({ encrypt: vi.fn(() => ({ encrypted: 'ciphertext', iv: 'iv', authTag: 'tag' })) }));
import { archiveSupportDocument } from '../../custom/x-gateway/support-document-storage.js';

const document = { format: 'markdown' as const, title: 'Private title', category: '', tags: [], content: 'secret', contentHash: 'a'.repeat(64), chunks: [] };
function enable() {
  vi.stubEnv('SUPPORT_DOCUMENT_STORAGE', 'azure');
  vi.stubEnv('AZURE_STORAGE_ACCOUNT_NAME', 'sttestdocuments');
  vi.stubEnv('AZURE_STORAGE_CONTAINER_NAME', 'tenant-documents');
  mocks.container.mockReturnValue({ getBlockBlobClient: mocks.blob });
  mocks.blob.mockReturnValue({ uploadData: mocks.upload });
  mocks.upload.mockResolvedValue({});
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('Azure support document archive', () => {
  it('does not contact Azure when disabled', async () => {
    vi.stubEnv('SUPPORT_DOCUMENT_STORAGE', 'disabled');
    expect(await archiveSupportDocument(1, 'src_a', document)).toBeUndefined();
    expect(mocks.container).not.toHaveBeenCalled();
  });
  it('uploads only an encrypted envelope with a tenant-scoped immutable key', async () => {
    enable();
    const key = await archiveSupportDocument(1, 'src_a', document);
    expect(key).toBe(`tenants/1/knowledge/src_a/${document.contentHash}.json`);
    expect(mocks.blob).toHaveBeenCalledWith(key);
    const [bytes, options] = mocks.upload.mock.calls[0];
    expect(JSON.parse(bytes.toString())).toEqual({ version: 1, encrypted: 'ciphertext', iv: 'iv', authTag: 'tag' });
    expect(bytes.toString()).not.toContain('secret');
    expect(options.conditions).toEqual({ ifNoneMatch: '*' });
    expect(options.abortSignal).toBeDefined();
  });
  it('separates identical documents belonging to different tenants', async () => {
    enable();
    expect(await archiveSupportDocument(1, 'src_a', document)).not.toBe(await archiveSupportDocument(2, 'src_a', document));
  });
  it('accepts an existing immutable blob on retry', async () => {
    enable(); mocks.upload.mockRejectedValueOnce({ statusCode: 412, code: 'ConditionNotMet' });
    expect(await archiveSupportDocument(1, 'src_a', document)).toContain('/knowledge/');
  });
  it('sanitizes provider errors and fails closed', async () => {
    enable(); mocks.upload.mockRejectedValueOnce(new Error('secret-token'));
    await expect(archiveSupportDocument(1, 'src_a', document)).rejects.toMatchObject({ status: 503, code: 'document_storage_unavailable' });
    mocks.upload.mockRejectedValueOnce(new Error('secret-token'));
    await expect(archiveSupportDocument(1, 'src_a', document)).rejects.not.toThrow('secret-token');
  });
  it('rejects malformed account configuration and path segments before networking', async () => {
    enable();
    await expect(archiveSupportDocument(1, '../other', document)).rejects.toThrow();
    await expect(archiveSupportDocument(0, 'src_a', document)).rejects.toThrow();
    vi.stubEnv('AZURE_STORAGE_ACCOUNT_NAME', 'https://evil.example');
    await expect(archiveSupportDocument(1, 'src_a', document)).rejects.toThrow();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('rejects unknown backends instead of silently losing archives', async () => {
    vi.stubEnv('SUPPORT_DOCUMENT_STORAGE', 'azuer');
    await expect(archiveSupportDocument(1, 'src_a', document)).rejects.toThrow();
  });
  it('honors an already aborted request', async () => {
    enable(); const controller = new AbortController(); controller.abort();
    await expect(archiveSupportDocument(1, 'src_a', document, controller.signal)).rejects.toThrow();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
