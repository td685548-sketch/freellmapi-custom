// The unified gateway key (GET /api/settings/api-key) used to be fetched
// under two different query keys — ['unified-key'] in most places and
// ['api-key'] in AgentsPage / IdeConfigPackagerCard — so the same secret was
// fetched twice and held in two cache entries. Every reader uses this one
// key so React Query dedupes the request and a rotation invalidates one
// entry, not two.
//
// gcTime is deliberately short: the default keeps an unused entry for
// 5 minutes after unmount, which left the full plaintext key sitting in the
// cache long after the operator navigated away. 60s is enough to dedupe the
// mount storm / page-to-page navigation (staleTime is 30s) and then evicts it.
export const UNIFIED_KEY_QUERY_KEY = ['unified-key'] as const;

export const UNIFIED_KEY_GC_TIME_MS = 60_000;
