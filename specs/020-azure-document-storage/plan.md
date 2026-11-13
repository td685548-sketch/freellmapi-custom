# Implementation Plan: Azure tenant document archive

Branch: codex/azure-document-storage. TypeScript ESM / Node 20+, official @azure/storage-blob and @azure/identity. SQLite remains authoritative.

## Constitution Check
Standalone custom adapter, one import hook, opt-in config, no new public routes/schema/migrations. Credentials remain outside Git. Reuse AES-GCM encryption and existing authorized import flow. Tests precede adapter implementation.

## Design
`server/src/custom/x-gateway/support-document-storage.ts` validates account/container/backend and identifiers, lazily loads the SDK with DefaultAzureCredential, and uploads encrypted normalized content with ifNoneMatch '*'. Existing immutable blobs count as successful retries. A finite AbortSignal covers credential acquisition and upload; all provider failures become document_storage_unavailable, never contain provider details.
`support-evidence-store.ts` archives validated normalized content before its synchronous transaction; the transaction rechecks source version and abort state. No Azure await occurs inside a DB transaction. An upload followed by a conflicting transaction can leave an orphan object; do not delete it in a failure handler because another concurrent successful import can reference the same key. Object archive is not the runtime retrieval source.

## Infrastructure
rg-freellmapi-documents / stfreellmdocs261114 / tenant-documents, southeastasia, Standard_LRS Hot, HTTPS/TLS1.2, anonymous access disabled, Shared Key disabled. Identity RBAC at account scope. No account keys or SAS.

## Delivery and verification
1. Record requirements and focused failure cases.
2. Add mocked Azure adapter tests and DB import failure integration tests.
3. Implement adapter, hook, env example and deployment guide.
4. Build shared/server, run adapter/store/import/router tests and lint changed files.
5. Real SDK encrypted roundtrip and anonymous denial; inspect infrastructure settings.

## Risks
Storage charges consume student credit. Production identity and environment must be configured on the hosting machine; local Azure login is not deployment. Preserve ENCRYPTION_KEY for decrypting archives. No retention policy is enabled until a product retention policy exists. No full database recovery from Blob alone.
