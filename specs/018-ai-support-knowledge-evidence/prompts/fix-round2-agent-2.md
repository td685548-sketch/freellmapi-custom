# Agent2 — review round2

Read AGENTS.md, spec018 contracts/ownership and `../review-round-2.md`. Work on existing feat/9router-integration; only Agent2-owned paths. No commit/push/PR/merge, branch switch, package changes, skipped tests or type suppression. Peer files/docs read-only.

Address R2-04: fresh/stored validators catch getSupportEvidencePolicy errors and use caller/default policy. Remove verified-success fallback on unavailable/corrupt policy storage. Preserve the typed fail-closed503 contract, coordinate error semantics with Agent3 without editing its files.

Use real-store regressions: publish authorized source, retrieve valid pack, verify baseline citation, then corrupt/unavailable policy read. Fresh validator must never return valid:true and stored validator must never accept the stale record; confirm expected typed error/outcome. Reviewer reproduced both accepting after policy_json became invalid JSON. Keep positive tests based on actually saved policy; do not catch missing setup and invent defaults.

Run owned retrieval/evaluation tests and report exact results. Preserve new last-case deadline/final snapshot checks and mode-agnostic preview/eval. Reviewer owns final full checks and PR.
