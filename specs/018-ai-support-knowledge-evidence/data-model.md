# Canonical Data & Service Contracts

Frozen handoff for018. Agent1 owns shared DTOs and all new persistence; Agent2 owns retrieval/verification/evaluation; Agent3 owns runtime bridging. Change a contract only through reviewer coordination, never by editing a peer's file.

## Limits and primitive types

- tenantId is the verified positive integer x_support_tenants.id; userId comes from verified017 context. Role is guest/customer/staff/admin for new source/eval inputs. Required-mode callers with another role are denied403 unsupported_evidence_role (never coerced); off mode preserves existing custom-role behavior.
- One incoming export/body <=1,048,576 UTF-8 bytes; normalized document <=64,000 JS string code units; UTF-8 only. Source title/name <=200 chars, category <=80, tags <=20 of <=40 chars.
- At most50 sources/tenant including archived,20 immutable revisions/source,128 chunks/revision and4000 simultaneously published new-source chunks/tenant. Required-mode legacy adapter supports <=100 enabled role-visible legacy docs and <=128 chunks/doc; over-limit is an explicit error, not truncation/false coverage. Off mode keeps017 limits/behavior.
- Chunk target1000 code units, overlap100, no split surrogate pairs; preserve heading and1-based start/end lines against canonical NFC text (BOM removed, CRLF -> LF). A revision rejects if it exceeds128 chunks.
- FAQ JSON is an array of1..100 `{question:string, answer:string}`; question<=500, answer<=4000 and combined normalized text<=64,000. Render each question/answer to canonical plain text before chunking.
- Source/Revision/Chunk/Suite/Run IDs are server-generated opaque strings <=80 chars. Case IDs are client-selected ASCII [A-Za-z0-9_-],1..80 chars, unique within a suite, and confer no global identity or access. Legacy virtual source IDs use `legacy:<docId>` and do not create DB rows.
- Required completion text <=16,000 code units and <=50 citation marker occurrences (1..5 distinct IDs); exceeding either is invalid_citations before rendering/parsing further.
- No newly added package; no native binary, PDF or HTML conversion.

## Shared DTOs — shared/support-evidence.ts (Agent1)

Use these names and exact value semantics; timestamps ISO8601 UTC. Export SUPPORT_EVIDENCE_LIMITS with all fixed caps below and DEFAULT_EVIDENCE_POLICY with version1 and updatedAt=1970-01-01T00:00:00.000Z; healthy missing policy returns a fresh copy, never a moving timestamp.

- SupportEvidenceRole = guest | customer | staff | admin.
- SupportEvidenceSource: id, tenantId, name, kind(text|markdown|faq_json|url), status(active|archived), allowedRoles(nonempty unique known roles; default[admin], no wildcard), version(positive OCC integer), publishedRevisionId(string|null), draftRevisionId(string|null), revisionCount, createdAt, updatedAt. Never expose stored import URL in public chat metadata.
- SupportEvidenceRevision: id, tenantId, sourceId, format(text|markdown|faq_json), title, category, tags, contentHash, chunkCount, createdAt. Body is returned only in editor detail as `content`; list responses do not include it. Revisions are immutable; source pointer controls publication. Newest draft need not be published.
- SupportEvidenceChunk: id, tenantId, sourceId, revisionId, ordinal, heading?, startLine, endLine, text, contentHash. Internal only; load/decrypt only for allowed published sources. Legacy chunks use sourceId legacy:<docId> and revisionId derived from current doc/ACL/content hash.
- SupportEvidencePolicy: mode(off|required; default off), includeLegacyDocs(boolean; default true), topK(integer1..5; default3), minCoverage(number0..1; default0.25), maxEvidenceChars(integer1000..12000; default6000), version(positive integer), updatedAt. Runtime policy update is a separate endpoint from017 runtime policy. Unreadable/corrupt saved policy errors; only a healthy missing row defaults off.
- SupportEvidenceCandidate: citationId, sourceId, revisionId, chunkId, title, startLine, endLine, providedText, providedTextHash, lexicalCoverage, score. Internal trusted set only, never accepted from a caller/model.
- SupportEvidencePack: tenantId, role, policyVersion, snapshotId(sha256 hex), contextPrompt, candidates. Entire contextPrompt must fit min(policy.maxEvidenceChars, runtimePolicy.maxContextChars). Only candidates whose text appears in that prompt may be returned. Clip a chunk to fit on code-point boundaries, keeping >=80 code units unless the whole chunk is shorter; omit candidates with no meaningful space. Prompt wrapper/title/markers count toward budget.
- SupportEvidenceCitation: id(citationId), ordinal(1-based appearance order), sourceId, revisionId, chunkId, title, startLine, endLine, excerpt(<=240 chars). No import URL/full document/ACL list/credential/userId in public citation. All user-visible text masked for the current viewer role; excerpt is from providedText, not unseen text outside the pack.
- SupportAnswerEvidence: requestId, status(cited|abstained|redacted), reason?(no_matches|invalid_citations|sources_changed|source_revoked), policyVersion, snapshotId, citations(array<=5). Redacted historical messages expose no original source IDs/titles/excerpts or old snapshot; use empty snapshotId and citations[].
- SupportEvidenceCase: id, query(1..500 chars), role, expectedSourceIds(array<=10), forbiddenSourceIds(array<=10), expectAbstention(boolean). Expected and forbidden IDs must be disjoint; empty expected list is allowed only with expectAbstention=true. Source IDs must belong to this tenant when saving a case; archived in-tenant sources may be referenced for regression testing. Existing cases may later refer to deleted legacy docs and should fail honestly when run.
- SupportEvidenceSuite: id, tenantId, name(1..200), version, cases(1..50), createdAt, updatedAt. OCC version required for updates.
- SupportEvidenceRun: id, tenantId, suiteId, suiteVersion, status(completed|partial|failed), startedAt, completedAt, casesChecked, totalCases, matchedExpectedCases, expectedCasesChecked, casesWithoutForbiddenHits, correctlyAbstainedCases, hitAtK(number0..1), allPassed(boolean), snapshotIds, results[]. Each result contains caseId, role, returnedSourceIds restricted to that role, expectedHit, forbiddenHitCount, abstentionMatched, passed; never include forbidden titles/snippets. A partial/error run has allPassed=false and reports unexecuted cases.
- SupportEvidenceValidation: valid:boolean, canonicalReply:string, citations:SupportEvidenceCitation[], reason?(invalid_citations|sources_changed). Internal only.

Extend shared/support-runtime.ts additively (Agent1): SupportRuntimeMetadata.replySource becomes model | knowledge_abstention; add optional evidence:SupportAnswerEvidence. Do not change old policy defaults or require new request fields. Off-mode payloads are unchanged. Agent3 extends the server-only generation result's modelUsed to string|null: null only when no model ran; an actually called provider remains recorded even if its answer is withheld.

## Persistence — single new migration, Agent1

`20261113_090001_support_evidence.ts`, registered in db/migrate/defaults.ts, with default roundtrip expectation updated. Do not edit017 or any existing migration.

Create x_support_evidence_sources, x_support_evidence_revisions, x_support_evidence_chunks, x_support_evidence_policies, x_support_evidence_suites, x_support_evidence_runs, x_support_evidence_answers. All tenant-scoped; source/revision/chunk relationships enforce same tenant and unique source revision hash/ordinal through keys or transactional validation. Index tenant+state/published pointer, source+revision and answer conversation/message lookups. Use current Db abstraction; ensure source service initializes the existing lazy support tenant schema before writes and validates tenant existence. Tenant references cascade on tenant deletion; migration roundtrip must also work before lazy tenant tables have been created (no duplicating their schema in018), and with populated018 tables. Avoid circular foreign keys that prevent down(); published pointer integrity may be validated transactionally. Down removes only018 objects, preserving017 data.

Encrypt canonical revision payload(title/category/tags/body), chunk text/heading, saved import URL, suite cases and detailed run results using existing AES-GCM helpers. No plaintext body/cache/search index alongside ciphertext. Plaintext IDs, safe source name, role lists, counters, hashes and timestamps are permitted; mask names on any viewer boundary. Use normal ENCRYPTION_KEY initialization, never a fallback secret. Legacy docs remain in their existing store; do not silently migrate or copy them into new tables.

Answers retain encrypted internal reference data with tenantId/userId/role/requestId/turnId, conversationId, customerMessageId and optional assistantMessageId. They must outlive017's24-hour turn-cache cleanup while the transcript exists: no cascading FK from answers to runtime turns. Keep only provenance and safe notice data, not the rejected model reply or a new raw document copy. Link the row to tenant deletion; all lookups require tenant and verified owner scope.

OCC: source create version1; every accepted source/draft mutation increments version. Require expectedVersion on revision import, publish, archive and ACL update. All source mutation/version checks execute in a short transaction; failed/missing version returns409/400 without partial writes. Idempotency key for import is tenant/source + canonical revision payload hash; reimport identical revision returns its existing ID (and does not consume revision capacity). A stale expectedVersion still conflicts before dedup; no silent lost update. An identical deduplicated import has no mutation: it leaves source version/pointers and stored origin unchanged. Draft edits never affect the active snapshot. Policy and suite updates also require expectedVersion.

Snapshot = hash of relevant policy/version, verified role, current masking-policy version, published new-source revisions/ACL/state and role-visible current legacy revision hashes in stable ID order. Draft pointer/OCC version/name changes alone are excluded. Recompute before final answer commit and replay; legacy changes are detected without editing support-knowledge.ts. Public snapshot hashes reveal no raw source/role configuration.

## Required source/store exports — Agent1

All below synchronous unless named import; throw typed SupportEvidenceError(status, code, safe message). Mutations use current getDb/short transactions and can participate in an outer runtime transaction. Reject unknown keys/types at service boundary as well as HTTP boundary.

- ensureSupportEvidenceTables(db?:Db): Db; getSupportEvidencePolicy(tenantId); updateSupportEvidencePolicy(tenantId, patch, expectedVersion).
- listSupportEvidenceSources(tenantId); getSupportEvidenceSource(tenantId, sourceId); createSupportEvidenceSource(tenantId, input:{name,kind,allowedRoles?}); updateSupportEvidenceSource(tenantId,sourceId,patch:{name?,allowedRoles?,status?},expectedVersion).
- importSupportEvidenceRevision(options:{tenantId,sourceId,expectedVersion,title,category?,tags?,format,content?:string,url?:string,signal?:AbortSignal}): Promise<{source,revision,deduplicated}>. Exactly one of content/url; url only for kind url. Reads network/normalizes/chunks outside transaction, verifies signal and source version immediately before commit.
- listSupportEvidenceRevisions(tenantId,sourceId); getSupportEvidenceRevision(tenantId,sourceId,revisionId) (editor-only caller); publishSupportEvidenceRevision(tenantId,sourceId,revisionId,expectedVersion) -> updated source.
- listPublishedSupportEvidenceChunks(tenantId,role) -> authorized decrypted chunks + immutable revision titles/category/tags; getCurrentSupportEvidenceCatalog(tenantId,role) -> current publication/ACL/hash metadata. May not include draft/archived/cross-tenant chunks. Return typed over-capacity rather than silently capping candidates.
- saveSupportEvidenceSuite(tenantId,input:{id?:string,name:string,cases:SupportEvidenceCase[]},expectedVersion?:number):SupportEvidenceSuite; listSupportEvidenceSuites(tenantId); getSupportEvidenceSuite(tenantId,suiteId).
- saveSupportEvidenceRun(tenantId,input:Omit<SupportEvidenceRun,'id'|'tenantId'>):SupportEvidenceRun generates a new immutable report ID; listSupportEvidenceRuns(tenantId) returns latest50; getSupportEvidenceRun(tenantId,runId). All require tenant scope.
- saveSupportAnswerEvidence(record) / getSupportAnswerEvidence(tenantId,userId,turnId) / getSupportMessageEvidence(tenantId,conversationId,messageId). Save in the same outer runtime transaction as messages/settlement/cache; no async await within it.

## Required engine exports — Agent2

Use these names; signatures derive from shared DTOs, verified primitive scope and installed Db/source APIs. No router/runtime imports, model calls or module-level network work.

- retrieveSupportEvidence({tenantId,role,query,policy,maxContextChars}) -> SupportEvidencePack (read-only).
- getSupportEvidenceSnapshotId({tenantId,role,policy}) -> string; buildCurrentLegacyEvidence uses listSupportKnowledgeDocs, filters enabled/allowedRoles before chunking; do not mutate legacy docs.
- validateSupportEvidenceReply({tenantId,role,policy,pack,reply}) -> SupportEvidenceValidation. Verify candidate membership, current snapshot/publication/ACL and provided text; does not perform semantic entailment judging.
- validateStoredSupportEvidence({tenantId,role,policy,record}) -> boolean. Works after runtime-turn TTL cleanup and checks current policy/masking/source visibility. No historical source body leaks on failure.
- runSupportEvidenceSuite({tenantId,suiteId}) -> SupportEvidenceRun. <=50 cases, bounded2-second CPU budget (partial is explicit); no AI/network/quota/mutations outside saving its own report. Reports version/snapshots and check failures honestly.

## Required runtime bridge — Agent3

support-evidence-runtime.ts coordinates existing runtime and engine. Provide `prepareSupportEvidenceTurn`, `finalizeSupportEvidenceTurn`, `assertSupportEvidenceReplay`, `sanitizeSupportEvidenceConversation` with typed contracts from above. Never create a second turn/quota executor. A sanitize helper receives plain conversation data and verified/original-customer role; it must not import workflow runtime values (type-only imports allowed), avoiding workflow -> helper -> workflow cycles.

SupportConversationMessage gains optional evidence and responseNotice:{requestId, reason:no_matches|invalid_citations|sources_changed}. Non-AI notice lives on the one customer message; there is no fake ai_assistant message. A cited AI message stores safe evidence and a separate durable internal record for revalidation. Browser/poll rendering deduplicates cited answers/notices by requestId within current tenant/token identity.
