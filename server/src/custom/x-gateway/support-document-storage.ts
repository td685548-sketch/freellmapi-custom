import { encrypt } from '../../lib/crypto.js';
import { SupportEvidenceError, type NormalizedSupportEvidenceRevision } from './support-evidence-import.js';
import type { ContainerClient } from '@azure/storage-blob';

let cached: { key: string; container: ContainerClient } | undefined;

function unavailable(): SupportEvidenceError {
  return new SupportEvidenceError(503, 'document_storage_unavailable', 'Document archive is unavailable. Check storage configuration and identity permissions.');
}

/** Additive encrypted archive; existing DB content remains authoritative for RAG.
 * Called only after the import service has validated tenant/source ownership.
 */
export async function archiveSupportDocument(
  tenantId: number,
  sourceId: string,
  document: NormalizedSupportEvidenceRevision,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const backend = process.env.SUPPORT_DOCUMENT_STORAGE ?? 'disabled';
  if (backend === 'disabled') return;
  if (backend !== 'azure') throw unavailable();

  const account = process.env.AZURE_STORAGE_ACCOUNT_NAME ?? '';
  const container = process.env.AZURE_STORAGE_CONTAINER_NAME ?? 'tenant-documents';
  if (!/^[a-z0-9]{3,24}$/.test(account)
    || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(container)
    || !Number.isSafeInteger(tenantId) || tenantId <= 0
    || !/^[a-zA-Z0-9_-]{1,200}$/.test(sourceId)
    || !/^[a-f0-9]{64}$/.test(document.contentHash)) throw unavailable();

  const key = `tenants/${tenantId}/knowledge/${sourceId}/${document.contentHash}.json`;
  const abortSignal = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  try {
    abortSignal.throwIfAborted();
    if (cached?.key !== `${account}/${container}`) {
      const [{ BlobServiceClient }, { DefaultAzureCredential }] = await Promise.all([
        import('@azure/storage-blob'), import('@azure/identity'),
      ]);
      const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential(), {
        retryOptions: { maxTries: 2, tryTimeoutInMs: 5_000, retryDelayInMs: 250 },
      });
      cached = { key: `${account}/${container}`, container: service.getContainerClient(container) };
    }
    abortSignal.throwIfAborted();
    const envelope = { version: 1, ...encrypt(JSON.stringify({ tenantId, sourceId, document })) };
    await cached.container.getBlockBlobClient(key).uploadData(Buffer.from(JSON.stringify(envelope)), {
      abortSignal,
      conditions: { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' },
    });
    return key;
  } catch (error) {
    // Never overwrite immutable content or expose SDK requests, credentials or content.
    if (!abortSignal.aborted && typeof error === 'object' && error !== null
      && 'statusCode' in error && error.statusCode === 412
      && 'code' in error && error.code === 'ConditionNotMet') return key;
    throw unavailable();
  }
}
