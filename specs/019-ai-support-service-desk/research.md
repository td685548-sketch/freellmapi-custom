# Research and decisions

Baseline inspected2026-11-13: PR25 (018) merged; all applicable CI jobs succeeded (manifest publication intentionally skipped on PR). Local branch ba0de18b contains018; origin/main must be safely synchronized by the coordinator before final publication. Kiro.ts and untracked016 docs are pending user work.

## Existing code evidence

- support-runtime.ts owns authoritative context, turn claims/leases, no-match shortcut and both commit transactions. Required intake must cover both commits without changing off-mode/replay behavior.
- support-evidence-retrieval/runtime/store provide real role-filtered packs, citation validation, policy/masking snapshots, encrypted durable provenance and history redaction. Reuse them for Copilot; do not invent confidence or an alternate vector store.
- support-workflows.ts: createSupportEscalationTicket, addHumanAgentReply and updateSupportEscalationTicket are canonical writes; conversations/tickets currently live in settings. New SLA state must be atomic with these writes, not only a new router.
- getSupportConversationForUser/listSupportConversations revalidate018 using viewer/original customer role. Copilot must select conversation metadata through existing tenant-scoped listing then get it with its original customer's userId/role, not staff role to widen evidence.
- executeSupportChatPipeline has disableTools hooks, provider selection/failover and usage callbacks; usedFallback must remain an error for real AI features. It must not be used as a substitute for draft verification/accounting.
- Served widget is support-runtime-widget.ts; main already recognizes canonical/legacy script suffixes and keeps deployment prefixes. Dynamic module wrappers still serve this factory. Editing a second unused widget would not implement019.
- Native createRoot/act pattern is established; React Testing Library is not a dependency. Auth service exports createUser/createSession; dashboard uses Bearer or X-Dashboard-Token. createSupportTenant returns {tenant,signingSecret}.

## Deliberate differences from old016

Old016 accepts browser userId/userRole/customerContext and suggests CRM binding, unmeasured confidence/performance, and legacy /x mounts. None is an approved019 contract. Replace it with verified017 sessions, server-selected context,018 evidence, dedicated operator budget, explicit UTC SLA cycles and canonical /thruline routes. Preserve016 as reference, not a concurrent implementation brief.

## Bounds and compatibility

Default-off config preserves existing widget init behavior and tests. New generated snippet opts into profile loading; enabling required intake is enforced at the server even for callers who omit that browser option. SLA hooks must no-op for legacy nonnumeric tenant fixtures and disabled policies, without new global fake state or swallowed storage failures for real tenants.

No new library is needed: built-in crypto/AbortController, existing safe auth/masking, SQLite Db interfaces, React Query and existing model pipeline suffice. All new sensitive structured payloads use existing AES-GCM; no awaits inside DB transactions. Existing budgets/claims are not silently repurposed to charge the customer for operator drafts.
