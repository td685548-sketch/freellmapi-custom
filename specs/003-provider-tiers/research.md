# Research
- Decision: reuse existing expectedReliability, speedScore, intelligenceComposite/intelligenceScore. Rationale: existing normalized axes; no independent quality benchmark exists. Alternative: external benchmark calls rejected because they consume quota and broaden scope.
- Decision: read requests, not request_attempts. Existing requests record isolated dispatch outcomes; attempts would double-count them. Cancel/pre-dispatch rejects are excluded.
- Decision: separate grouped key counts and observations. Rationale: fixed two DB reads and no fan-out. Alternative: per-provider queries rejected due Turso latency.
- Decision: fixed balanced informational ranking, 20-sample gate, S/A/B/C/D defaults. Current key availability and missing axes are explicit. This does not alter routing strategy.
- No external API/library changes or unresolved technical questions.
