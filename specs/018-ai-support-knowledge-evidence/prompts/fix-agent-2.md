# Agent2 — round1 corrections

Work in the existing checkout on `feat/9router-integration`. Read AGENTS.md, spec018 contracts/data-model/ownership and `../review-findings.md`. Only Agent2-owned retrieval/evaluation modules, their tests and fixture may be edited. Peer files and docs are read-only. No commit/push/PR/branch switch, packages, skipped tests or type suppressions.

Address F04 jointly with Agent3, and F12:

1. Agree with Agent3 how final validation compares the pack against the currently saved policy/version and current source/masking/legacy snapshot. Hashing the original policy twice misses in-flight policy updates. Keep mode-agnostic preview/eval and draft-only stability semantics. Agent3 owns runtime orchestration and atomic commit recheck; do not edit those files.
2. Add a real-store regression: retrieve at version2, change saved policy to version3, validate old pack under the runtime validation contract. The old generated answer must not be accepted. Preserve actual bounded citation text/hash checks and role isolation.
3. Fix evaluation budget checks after retrieval/before save, including one-case/last-case overrun. Label results with the actual pack snapshot; detect inconsistent policy/source snapshots even when each role appears once or its last case already ran. Return partial/allPassed=false with honest counters rather than a completed report.
4. Add deterministic boundary tests for those cases. Preserve zero AI/network/tool/quota effects and existing EN/VI four-role fixture coverage.

Run owned Vitest files, shared/server type checks once peer fixes are ready, and report exact results and API handshake. Existing16 retrieval and8 evaluation tests passing does not close the new boundary findings. Reviewer will handle final integration review/PR.
