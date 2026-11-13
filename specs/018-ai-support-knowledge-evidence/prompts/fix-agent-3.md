# Agent3 — round1 corrections

Use the existing `feat/9router-integration` checkout. Read AGENTS.md, spec018 contracts/data-model/ownership and `../review-findings.md`. Edit only Agent3-owned paths. All peer files/docs are read-only. No commit/push/PR/branch switch, packages, mock replacement production service, skipped tests or type casts that hide contract failures.

Address F01, F02, F03, F04, F07 and your part of F09:

1. Import requireAuth from its real middleware export and importSupportEvidenceRevision from the store. Align schemas/limits with actual shared DTO keys and bounds. Restore server compilation/bootstrap; do not fabricate duplicate exports.
2. Pass nested `evidence: SupportAnswerEvidence` to both provenance save callsites. Verify signed no-match/cited/discarded turns and atomic messages/notice/cache/quota/provenance persistence.
3. Revalidate every cached018 response before returning it even when current policy is off. Preserve pre018 off-mode cache compatibility. Revoke/archive/masking/policy changes ->409 without extra calls/charges; never regenerate silently under the old ID.
4. Coordinate F04 with Agent2: check fresh current policy/snapshot after provider work and inside synchronous commit. Deferred-provider tests must change policy/ACL/publication/masking while awaiting completion and prove raw rejected text never appears in public aliases, history or cache.
5. Replace req.close cancellation with actual disconnect lifecycle handling. A fully received POST must survive a delayed valid remote import; an actual disconnect must prevent late commit. Use real HTTP test coverage.
6. Fix runtime test imports and masking fixture using the real API/payload. Fix HTTP unused variable without dropping authorization coverage. Ensure HTTP tests collect and execute; do not equate collection failure with a tested endpoint.

Run new evidence HTTP/runtime tests plus affected017 runtime/workflow/gateway/enterprise regression files, server build/lint and built-app import after peer compile fixes. Report exact commands, pass/fail counts, actual export handshake and unresolved peer blockers. Reviewer owns final workspace gates and PR, not merge.
