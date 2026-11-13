# Feature Specification: Azure tenant document archive

**Feature Branch**: `codex/azure-document-storage`
**Created**: 2026-11-14
**Status**: Implementation
**Input**: Create a new Azure resource using Azure CLI and use it to store project documents.

## User Scenarios & Testing

### User Story 1 - Private durable document storage (Priority: P1)
The operator provisions a dedicated private storage account and imports tenant knowledge through the existing authenticated Knowledge Library.
**Independent Test**: Import a text/Markdown/FAQ document; verify an encrypted blob under that tenant's prefix and an unchanged retrievable database revision.
**Acceptance Scenarios**:
1. Given Azure archive configuration, when a valid import succeeds, its normalized document is archived before the database commit.
2. Given Azure denies writes, when importing, return a sanitized 503 and leave revisions/source versions unchanged.

### User Story 2 - Preserve local deployments (Priority: P1)
**Independent Test**: Run existing evidence tests without Azure configuration.
**Acceptance Scenarios**: Without an archive backend, imports retain existing SQLite behavior and make no Azure requests.

### Edge Cases
- Duplicate content is immutable and retry safe; tenant/source keys never overlap.
- A disconnect or bounded deadline cancels uploads before commit.
- A source conflict after an upload can leave an encrypted unreferenced archive; this is documented, never reported as a successful import.
- Archiving does not change source ACLs or publication state.

## Requirements
- **FR-001**: Provision a dedicated tagged Standard LRS account in Southeast Asia and a private container.
- **FR-002**: Enforce HTTPS, TLS 1.2 minimum, disable anonymous and Shared Key access; authorize identities through scoped Blob Data Contributor.
- **FR-003**: Enable Azure archiving with environment configuration; leave it disabled by default.
- **FR-004**: Archive normalized text/Markdown/FAQ revisions as AES-GCM envelopes with no content in object metadata or errors.
- **FR-005**: Use tenant/source/content-hash keys, conditional immutable writes, finite upload deadlines and sanitized 503 errors. Reject known revision-capacity overflow before uploading; continue accepting duplicate revisions at capacity.
- **FR-006**: Preserve all existing authentication, tenant authorization, optimistic version checks and database retrieval.
- **FR-007**: Provide a real upload/download verification and deployment instructions without committed credentials.

### Key Entities
- Archive object: encrypted normalized revision, versioned envelope, tenant/source/hash key.
- Existing database revision: authoritative encrypted content, ACL and chunks; no new table.

## Success Criteria
- **SC-001**: An actual encrypted object can be uploaded, downloaded and decrypted with identical content.
- **SC-002**: Anonymous reads are denied and all storage tests pass.
- **SC-003**: Storage failure leaves zero newly committed revisions.
- **SC-004**: Server build and relevant existing evidence tests pass with storage disabled.

## Assumptions
This is an additive archive for the existing Knowledge Library, not a replacement database. Existing documents are not backfilled. Original PDF/DOCX binary uploads, Markdown parsing, vector indexing, archive browsing/restoration, automated orphan cleanup and production deployment are outside this change. Archived source data is retained when a source is archived; tenant erasure requires coordinated deletion of its Blob prefix and database records. No arbitrary browser access or CORS is enabled. A production hosting identity must receive storage RBAC separately.
