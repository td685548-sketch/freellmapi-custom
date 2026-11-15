# Frozen020 contracts

Implement these exact names. Missing export is a dependency to report, never permission for a production fallback. Agent1 owns shared DTOs; Agent2 owns evaluator exports. No arbitrary regular expressions or replacement strings from users.

## Shared types — shared/support-output.ts

```ts
type SupportOutputMode = 'off' | 'log' | 'enforce';
type SupportOutputSurface = 'chat' | 'copilot';
type SupportOutputReason =
  | 'blocked_term' | 'too_long' | 'credential' | 'inspection_limit';
interface SupportOutputRule { id: string; text: string; }
interface SupportOutputPolicy {
  tenantId: number;
  version: number;
  mode: SupportOutputMode;
  blockedTerms: SupportOutputRule[];
  maxOutputChars: number;
  redactCredentials: boolean;
  updatedAt: string;
}
interface SupportOutputLeaf { path: string; text: string; }
interface SupportOutputDecision {
  action: 'allow' | 'observe' | 'redact' | 'block';
  leaves: SupportOutputLeaf[];
  reasons: SupportOutputReason[];
  ruleIds: string[];
  redactionCount: number;
  policyVersion: number;
}
interface SupportOutputMetadata {
  policyVersion: number;
  action: SupportOutputDecision['action'];
  reasons: SupportOutputReason[];
  redactionCount: number;
}
interface SupportOutputEvent {
  id: string;
  tenantId: number;
  operationId: string;
  surface: SupportOutputSurface;
  policyVersion: number;
  action: SupportOutputDecision['action'];
  reasons: SupportOutputReason[];
  ruleIds: string[];
  redactionCount: number;
  createdAt: string;
}
```

Export all types plus SUPPORT_OUTPUT_LIMITS, DEFAULT_SUPPORT_OUTPUT_POLICY (policy fields except tenantId), SUPPORT_OUTPUT_BLOCK_NOTICE and SUPPORT_OUTPUT_HISTORY_NOTICE. Defaults: version0, mode off, blockedTerms[], maxOutputChars16000, redactCredentials=false, updatedAt1970-01-01T00:00:00.000Z. Default healthy absent policy only; corrupt storage throws typed503.

Bounds: <=50 rules, ASCII id [A-Za-z0-9_-]{1,64}, unique IDs and unique normalized terms; term1..100 code units after trim/normalization; maxOutputChars integer256..64000; <=32 leaves with unique path1..128; total<=128000 raw code units. These hard inspection limits are distinct from configurable output length.

Notices exact:
- block: "This AI response was withheld by the organization's output policy. Please contact support."
- history: "This AI response is unavailable under the current output policy."
Add optional output?:SupportOutputMetadata to SupportRuntimeMetadata (Agent1). Add replySource union member 'output_policy_notice' (Agent1). No browser field may set internal output/evidence metadata.

## Policy and event store — Agent1

Export SupportOutputError(status:number,code:string,message:string), with status and code properties.
- getSupportOutputPolicy(tenantId:number, db?:Db):SupportOutputPolicy
- saveSupportOutputPolicy(input:{tenantId:number;expectedVersion:number;policy:Pick<SupportOutputPolicy,'mode'|'blockedTerms'|'maxOutputChars'|'redactCredentials'>},db?:Db):SupportOutputPolicy
- appendSupportOutputEvent(input:Omit<SupportOutputEvent,'id'|'createdAt'>,db?:Db):void
- listSupportOutputEvents(input:{tenantId:number;limit:number;before?:string},db?:Db):{items:SupportOutputEvent[];nextCursor?:string}
- ensureSupportOutputTables(db?:Db):Db

Tenant IDs positive integers and existing tenant validated without leaking another tenant's records. Missing row is version0; first save expected0 creates1; subsequent saves increment once, stale409 output_policy_conflict. Strict schemas reject unknown fields and invalid types; no coercion from string/NaN. Store and router both validate their boundaries.

Migration20261115_120001_support_output_controls.ts: encrypted policy JSON using existing AES-GCM helpers, table x_support_output_policies keyed tenant_id; x_support_output_events with unique(tenant_id,surface,operation_id), metadata only. Events have no prompt, response, userId, user name, snippet, matched text, raw args/error or reversible content digest. Internally use stable runtime turn ID or Copilot job ID as operationId, never caller-supplied free text. Reason/rule IDs limited/validated; IDs must be opaque safe identifiers; no event for allow or off. Retain30 days and cap10000/tenant, prune on writes inside transaction; reads never clean up. Stable descending keyset by createdAt,id; opaque validated cursor<=512 chars; limit1..100. Repeated event insert is no-op; no duplicate counts on replay.

## Pure evaluator — Agent2

evaluateSupportOutput(input:{policy:SupportOutputPolicy;leaves:SupportOutputLeaf[]}):SupportOutputDecision

Order: validate structural policy/input; off returns unchanged valid leaves with allow (hard limits still apply at the adapter). In log/enforce inspect raw leaves with bounded normalization: Unicode NFKC, strip U+200B..U+200D/U+FEFF, lowercase, collapse whitespace, trim. Preserve accents. Match normalized literal substrings, including phrases; do not interpret regex or claim word boundaries/semantics. Count output length on original text summed over leaves. Never normalize returned display text.

Known credential patterns: nonempty Bearer token values, sk-.../sk_sup_... keys, sup_ctx_... tokens, supported private-key PEM blocks. Specify/test exact finite patterns; no claim of universal detection. Log observes without changing text. Enforce blocks blocked_term/too_long/inspection_limit; otherwise redact recognized credentials only when redactCredentials=true. Credential findings with that toggle false are observe, not block. On block return leaves=[]; no original text in error/decision. Reasons/rule IDs deduplicated in stable order. Bounded scanning must avoid catastrophic regex behavior.

For over-hard-limit input enforce blocks without scanning. Log/off adapter returns a safe503 output_inspection_limit rather than returning uninspected oversized content; no raw error. Invalid policy/input throws safe typed errors, not an allow.

## Integration adapter — Agent3

New support-output-runtime.ts, free of runtime/workflow imports. Agent3 publishes typed adapter signatures to Agent4; HTTP preview calls pure evaluator directly. Adapter applies policy only to explicit display text fields, never credentials needed for backend execution. Text leaves cover reply aliases, public tool trace strings/data and citation titles/excerpts; do not evaluate bookkeeping IDs/usage as prose. Do not mutate execution args, approval snapshots, token accounting or internal routing.

Compose018 validation -> current masking ->020 evaluation; if final visible answer changes, revalidate018 citations against final text/current source snapshot; never leave dangling/false citations. Invalid final evidence uses existing abstention path and no provider repair. Block replaces all answer aliases with fixed notice, strips public text traces/citations, stores only safe result/notice + optional output metadata; keep honest usage/model identity/pending action status, use replySource output_policy_notice. Never pretend provider wasn't called.

Read latest policy synchronously inside EACH final DB transaction; a concurrent update after that commit has a defined serialization order. Add output metadata to cached safe response. Version mismatch on020 replay409 output_policy_changed before returning cached content; legacy replay is evaluated under current policy and returns only a sanitized in-memory view. No new calls, message writes, quota mutation, event or cache update on replay.

Canonical history/list/provider-context reads apply current policy read-only to AI messages after existing018 source checks; use conversation's original userRole, including staff views. Legacy messages also inspected. No destructive history rewrite, no recovery of redacted raw. Use history notice for blocked AI message and strip its citation/trace text; human/customer messages unchanged by020. Preserve018 revocation guards and019 intake behavior.

Copilot if019 exists in accepted baseline: all summary/draft leaves as one decision, before stored result and before return/replay/read. On block discard whole artifact set, return typed422 output_blocked with safe fixed message, no raw artifact. Preserve job lease/cost settlement and no customer message/send. On changed output policy return409 output_policy_changed on replay/read, no regenerate. Add optional output metadata to Copilot result in shared/support-service-desk.ts (Agent3), without breaking existing defaults.

## Console API — Agent4

Mount once beneath existing /api/thruline/support:
- GET /tenants/:id/output-policy -> {ok:true,policy}
- PUT /tenants/:id/output-policy body {expectedVersion,policy} -> {ok:true,policy}
- POST /tenants/:id/output-policy/preview body {policy:<four mutable fields>,text:string} -> {ok:true,decision}. Construct server tenantId/version; return only decision from supplied preview; never save/audit/charge/call provider.
- GET /tenants/:id/output-events?limit=50&before=... -> {ok:true,items,nextCursor?}

All four operations editor-only: existing primary/admin/wildcard/manage_x_gateway OR use_x_gateway + edit_x_settings, matching018 editor gate. Tighten permission action mapping for these exact routes including GET/HEAD/preview: no read-leaf exposure of blockedTerms. Client route /thruline/support-output; permission denial server-authoritative. Body<=256KiB before JSON parsing for these routes; no global middleware change. Preview hard bounds apply to text, rule validation same store; no client-supplied tenant/version/metadata in nested policy.
Errors {error:{code,message}};401/403/404/400,409 output_policy_conflict,503 output_policy_unavailable/output_inspection_limit. Internal errors are fixed strings, never decrypted values.
