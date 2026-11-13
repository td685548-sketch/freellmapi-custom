# HTTP, Citation & Runtime Contracts

Canonical types/limits/service exports: [data-model.md](data-model.md). Preserve all013–017 endpoints and default behavior. Implementation-only endpoints below are not created by this specification step.

Integration update after main's Thruline rename: apply the [current-main URL mapping](integration-main.md) to historical URL prefixes below. Current canonical mounts are `/api/thruline`, `/thruline/v1` and `/thruline/support-knowledge`; do not restore obsolete mounts when integrating018.

## Trust and permissions

All new console endpoints live under `/api/thruline/support/tenants/:id/knowledge-library`. Require normal console authentication AND use_x_gateway AND edit_x_settings for **all reads and writes**, including preview/evaluations: source contents can be private. Do not map a console member to a support role implicitly. Cross-tenant source/revision/suite/run IDs ->404. Console viewer without edit permission ->403 and frontend issues no sensitive queries.

Public chat/history continue to use verified017 tenant/token/origin/owner checks. No new public source browser/export URL endpoint. New source ACL inputs are known support roles, not trusted claims from a partner browser. Server chooses policy, candidates and snapshot; reject attempted body `evidence`, `citations` or policy overrides with400 invalid_input, do not accept a client-supplied pack. evidence/responseNotice are server-only on every chat/conversation write path, not trusted metadata merely because a request shape contains those fields.

Errors keep017 envelope `{error:{code,message},requestId?}` with safe text. Codes: invalid_input400, import_too_large413, unsupported_import_format415, unsafe_import_target403, import_timeout504, source_conflict409, evidence_capacity_exceeded409, knowledge_source_not_found404, knowledge_context_changed409, evidence_storage_unavailable503; unsupported_evidence_role403. Existing model/quota/auth errors remain unchanged; set Retry-After where existing runtime knows it. Never echo raw remote response/import URL/query/body or discarded provider answer into an error.

## Source operations (editor only)

| Method/path under knowledge-library | Body / response |
| --- | --- |
| GET /sources | `{ok:true,sources:SupportEvidenceSource[]}`; no decrypted body/import locator |
| POST /sources | `{name,kind,allowedRoles?}` ->201 `{ok:true,source}`; default roles admin-only |
| PATCH /sources/:sourceId | `{expectedVersion,name?,allowedRoles?,status?}` -> `{ok:true,source}`; archive immediately removes active eligibility |
| GET /sources/:sourceId/revisions | `{ok:true,revisions:SupportEvidenceRevision[]}` |
| GET /sources/:sourceId/revisions/:revisionId | `{ok:true,revision:{...SupportEvidenceRevision,content}}`; editor-only decrypted detail |
| POST /sources/:sourceId/revisions | `{expectedVersion,title,category?,tags?,format,content}` OR same with url;201 created/200 deduplicated `{ok:true,source,revision,deduplicated}` |
| POST /sources/:sourceId/publish | `{expectedVersion,revisionId}` -> `{ok:true,source}` |
| GET /policy | `{ok:true,policy}`; missing healthy row returns version1 defaults |
| PUT /policy | `{expectedVersion,mode?,includeLegacyDocs?,topK?,minCoverage?,maxEvidenceChars?}` -> `{ok:true,policy}` |

No DELETE/purge endpoint v1; archive is the supported removal from retrieval. A revision is immutable; update by importing a new draft. Publishing an older retained revision is allowed as an explicit rollback, with current source ACL and OCC checks. Never change a published revision in place. Each source's prior published pointer stays valid while import is pending/failed. Publishing validates active chunk capacity in the same transaction as pointer change.

For source kind url, import requires url and no content; for other kinds, content is required and format must match the source kind.

Remote import: only editor-selected text export URL, no discovery/follow links/background sync. Accept http/https only via existing safeFetch with its DNS-bound destination checks, redirects denied, metadata always denied, no body-enabled localhost/trust option. No credentials, query, fragment or request-defined auth headers. Production URLs must be HTTPS; HTTP test origins require existing explicit server-owned trusted-origin configuration. Allow media types text/plain, text/markdown, application/json (FAQ schema) with absent/UTF-8 charset only; reject HTML/PDF/archive/binary. Whole request/fetch/body processing has a5-second deadline and1MiB byte cap; normalized text64,000 chars; stream-count bytes before full buffering. An aborted/expired import may never commit late. Hash/dedup includes normalized body and immutable title/category/tags/format, not just the URL. Recheck source version after network wait.

## Retrieval preview (editor only)

POST /preview `{query:string,role:SupportEvidenceRole}` -> `{ok:true,preview:{snapshotId,policyVersion,candidates:[{id,sourceId,revisionId,title,startLine,endLine,excerpt,lexicalCoverage,score}],contextChars,willAbstain}}`.

Preview explicitly simulates retrieval for required mode even while the policy is off; it must not imply that the default017 assistant is currently using these new sources. Preview uses current published eligible sources with policy limits; explicit preview role is only a sandbox selector under editor authorization. It never grants permissions, returns a signed identity, calls AI/CRM/tools or exposes hidden-role titles/snippets/counts. A public-key holder cannot use it. It is retrieval-only, clearly labeled in UI.

Retrieval/evaluation are mode-agnostic simulations: they can inspect published sources while policy.mode is off; only runtime decides whether to enable the new chat branch. Hash the actual saved policy, not a fabricated enable toggle. New-source ACL uses exact role membership with no implicit admin/staff inheritance; only the legacy adapter honors existing wildcard semantics.

Ranking v1: normalize query to lowercase NFD with combining marks removed; tokenize Unicode letters/digits, stable unique terms<=32, console/evaluation queries<=500 chars, runtime queries use the existing017 last-message limit<=16,000. Apply same normalization to title/tags/chunk. Let Q be term count; titleHits/tagHits/bodyHits count matching unique query terms. `lexicalCoverage = matching terms in title/tags/body union / Q`; `score = (3*titleHits + 2*tagHits + bodyHits)/(6*Q)`, range0..1. Empty token set ->no candidates. Require coverage>=minCoverage and at least one match; sort score desc, coverage desc, then sourceId/revisionId/ordinal stable. Return up to topK fitting the actual context budget. Do not label either metric as AI confidence. New source roles filter before decrypt/rank; legacy filter before chunk/rank.

## Citation protocol and answer handling

Completion text is bounded at16,000 code units/50 citation marker occurrences; over-limit is invalid_citations, never a truncated accepted answer. The server labels each provided candidate with an opaque citationId, e.g. `[cite:cit_abc123]`. Candidate IDs are bound to tenant/role/revision/chunk/provided text and the active snapshot. Prompt makes external content untrusted reference material. Only actual provided candidates may be cited; neither a user body nor arbitrary source instruction defines this set.

Model answer syntax is text plus `[cite:<citationId>]`. Required mode accepts1..5 distinct references, all from that turn's pack and still valid. Any unknown, stale or malformed `[cite:` marker rejects the answer; zero references also rejects it. Business-tool call markup in a required-mode completion also rejects it, even if a valid citation is present. Repeats of the same valid ID deduplicate. Canonicalize markers to `[1]`, `[2]` in appearance order and send ordered public citation DTOs; do not leak raw provider output or unsupported IDs in error/debug fields. Citation membership verifies provenance, not entailment; no percentage of factual correctness is claimed.

Additive runtime response in required mode:
- Existing reply/usage/conversation fields preserved; `runtime.replySource` is model for accepted model text or knowledge_abstention for explicit non-AI outcome.
- `runtime.evidence` is SupportAnswerEvidence. modelUsed (and corresponding model field) is null if no model ran; otherwise real provider/model selection remains truthful. Usage is actual or conservative per017, never fabricated.
- No matches before dispatch:200 with fixed safe English reply, abstained/no_matches, citations[], one customer message with responseNotice, no ai_assistant message, one request charged and zero tokens. Native widget localizes the notice by reason for EN/VI; API integrators may do likewise. It must be possible to call existing escalation with the returned conversationId.
- Invalid citations/current sources changed after a model call:200 abstained/invalid_citations or sources_changed; discard the rejected answer completely, retain observed/conservative cost, persist customer + responseNotice only. No second model call to repair citations automatically. Finalize the first successful completion once; do not feed invented tool-call markup into the agentic tool loop. Existing bounded provider failover before a successful completion may remain.
- Provider unavailable/timeout/error remains017 503; never relabel it as a successful knowledge abstention. Policy/store corruption fails closed503, not off mode.
- Required mode exposes no business-tool descriptors and forbids webhook/DB invocations and CRM memory injection at both pipeline and runtime helper boundaries. Existing manual escalation/CSAT work normally. Off mode remains017; no new source retrieval, model calls or abstention substitutions.

The persistence/conversation guarantees above apply to signed users, including signed guest sessions. Compatible unsigned guests remain stateless without conversation/provenance writes; their guest-only evidence and replay still undergo current-source checks. Native widget uses signed guest-session flow.

Claim/lease/firewall/quota ordering remains017. Before zero-model persistence reserve/charge only one request transactionally; before provider calls use existing conservative full-prompt reservations and output/deadline caps. Any citations/pack context count in that reservation. Store messages + evidence references + final cache + quota reconciliation in the same synchronous transaction with active turn/lease and snapshot recheck. Never await external work inside it. A generated answer rejected for bad citations is billed; a no-provider abstention is not billed for model tokens.

## Replay and history

- Do not change017 fingerprint semantics in off mode or invalidate pre018 caches unnecessarily. Required mode does not accept new caller policy/candidate fields.
- Under required mode an old cached reply without018 evidence is refused with409 knowledge_context_changed; never fabricate provenance for it. Before returning an018 cached result, recompute its current evidence/policy/masking snapshot for the verified role. A changed snapshot ->409 knowledge_context_changed, zero new provider/tool calls and no extra charge. No silent regeneration under that ID. Widget offers an explicit fresh-request retry with a new requestId, not a background resubmit.
- In-flight snapshot change ->safe sources_changed abstention; never store the now-disallowed model answer. Save the current revalidated snapshot for replay of that abstention; a later further change invalidates it normally.
- Source/ACL/masking/policy changes must affect018 transcript display as well as new retrieval. An invalid cited assistant message is wholly replaced with a safe localized redaction notice (machine reason source_revoked), citations removed; no original title/excerpt/source IDs in the returned evidence. Do not mutate stored raw history as a side effect of GET.
- Apply guards at canonical getSupportConversationForUser/listSupportConversations read boundaries and before provider history/cache return so HTTP consumers cannot bypass a sanitized wrapper. Public owner reads use verified current support role. Console conversation lists revalidate using each original customer's role, not an invented mapping from console RBAC role. Management of raw sources still requires editor permission.
- Required provider context excludes unprovenanced legacy assistant messages; old017 display behavior for messages without018 provenance is preserved. Never claim legacy messages are verified. Evidence provenance survives runtime-turn TTL cleanup.
- No-match/invalid-source notice belongs to the persisted customer message (responseNotice); widget renders it as a non-AI status, not a synthetic AI transcript message. Deduplicate notices/cited answers on requestId across local send, poll and reload; clear maps on tenant/token change/destroy.

## Evaluation endpoints (editor only)

GET/POST `/suites`; PUT `/suites/:suiteId` with expectedVersion; GET `/suites/:suiteId`; POST `/suites/:suiteId/runs` with an empty body; GET `/runs` (latest50), GET `/runs/:runId`. Standard `{ok:true,suites|suite|run|runs}` envelopes; POST suite/run returns201. No model selector, hidden judge or execution bypass input.

Save/query expected/forbidden source references only within tenant. A case passes when (expectedSourceIds empty or at least one expected source is in returned topK), no forbidden source appears and expectAbstention equals the actual empty-pack outcome. If expected sources were later removed, the case fails, not silently skips. `hitAtK` divides expected-hit cases by casesChecked that have nonempty expectedSourceIds; if denominator0, report0 with that denominator in the report rather than manufacturing100%. allPassed=true only for a completed run with every case checked/passed; partial/error false. Enforce max50 cases and2-second CPU deadline; each result states the snapshot actually used. If snapshots change during a run, mark partial/false rather than implying one consistent current version. Only save its own encrypted run report; no AI/network/quota or customer/ticket changes.

## UI contract (Agent4)

Route `/thruline/support-knowledge`; grouped Customer Support nav in shell/nav.ts and route in XGatewayApp.tsx, preserve current Thruline theme. Tenant selector `support-evidence-tenant`; tabs/panels `sources`, `preview`, `policy`, `evaluations` with `tab-<id>` and `panel-<id>` test IDs.

Sources: explain that published new sources are used by chat only after enabling required mode; create, text/file/export URL draft import, revision detail, publish with OCC, archive/unarchive and explicit role ACL. Preview: query/role and published candidate excerpts/lexical labels. Policy: explicit off/required and knowledge-only/no-CRM/no-business-tools explanation. Evaluations: edit case queries/roles/source expectations, run and show version/snapshots, counts and incomplete/error states. EN/VI, loading/error/empty/conflict, no sensitive requests for a non-editor, cancel/partition state on tenant/session changes.

Native widget: show canonical text plus numbered source buttons and plain-text excerpts; no navigation to internal import URLs. Handle abstention/redaction as localized status and allow human escalation; separate generation/network/auth failure. Abort/epoch checks apply to late citation results and rerenders. Untrusted title/excerpt/markers use safe DOM text, no innerHTML/HTML evaluation. Preserve all017 cross-origin base, guest renewal, request dedup, human sender types, CSAT and destruction behavior. Required-mode integrators must consume new replySource/null-model outcome; off-mode response contract is unchanged.
