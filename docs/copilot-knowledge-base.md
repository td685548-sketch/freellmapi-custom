# Setup Copilot knowledge base (RAG)

The Setup Copilot answers product questions from a read-only knowledge base (KB)
instead of a hand-written prompt. Code: `server/src/custom/support-setup-copilot/kb/`.

## What is in it

| Source | Where it comes from | Drift protection |
| --- | --- | --- |
| Permissions | generated from `PERMISSION_GROUPS` (`shared/permissions.ts`) | always in sync |
| System settings (9) | `kb/sources/settings.ts` (a full `Record<SupportSystemSettingId, …>`) | a new setting id without an entry fails the build |
| Tenant steps (7) | `kb/sources/tenant-steps.ts` (a full `Record<SupportSetupStepId, …>`), including each step's exact "complete" rule | same |
| Dashboard pages | `kb/sources/pages.ts` + the platform-guide route catalog | a test reads `client/src/App.tsx` and fails on an undocumented route |
| Troubleshooting | `kb/sources/troubleshooting.ts` (symptom → cause → fix, using the runtime's real error codes) | reviewed with the eval set |
| Web options (6) | `kb/sources/web-options.ts` — the controls a person can change on the web, tied to the error each one fixes (the 429 decision hub, per-key RPM, tenant role quotas, runtime bounds, upstream rate-limit absorbers, account allowances). Defaults are imported from the runtime constants | a test pins every literal that has no exported constant; recall is gated by the eval set |
| Docs | `docs/en/**` and a few top-level docs, baked into `kb/docs.generated.ts` | a test fails when the generated file is stale |

Regenerate the docs part after editing docs:

```bash
npm run kb:docs -w server
```

## How it is used

1. **Prompt injection** — every coach turn retrieves the top entries for the user's
   message (plus recent context for short follow-ups) and puts them in the prompt
   with answer-quality rules (cause before fix, remedy matches the problem's scope,
   name the next click, never invent pages or settings).
2. **Tools (read-only)** — `kb.search`, `settings.read` (live values of the settings
   the caller may manage) and `tenant.diagnose`. The agent loop feeds their data back
   to the model. They never stage or apply anything.
3. **Tenant Doctor** — "why does this tenant fail?" is answered from the tenant's own
   evidence (failed turns, firewall and output events, provider routes, runtime policy).
4. **Grounded fallback** — when no model route answers an error/limit question
   ("làm sao xử lý lỗi HTTP 429?"), `kb/answer.ts` composes the reply from the retrieved
   *option / troubleshooting / setting* entries instead of the canned 7-step roadmap or the
   intake questionnaire. `isTroubleshootingQuestion` is deliberately narrow (error vocabulary
   plus a system noun) so ordinary setup chatter is never intercepted.

## Retrieval

* BM25 over title/tags/body, accent-folded, with Vietnamese ⇄ English query expansion
  (`kb/synonyms.ts`) so Vietnamese questions reach English docs.
* Entries that need a permission are hidden from callers who lack it.
* Optional semantic layer: when an embeddings provider is configured, the KB is
  embedded in the background and fused with BM25 (reciprocal-rank fusion). If no
  provider is configured, or a call fails, BM25 keeps working and the build is retried
  after 15 minutes. Disable with `COPILOT_KB_SEMANTIC=0`.

## Evaluation

`server/src/__tests__/fixtures/copilot-kb/eval-cases.json` holds real questions with the
entries that must appear in the top 3; the test gates recall@3 ≥ 90 %. When the Copilot
answers badly, add the question here first, then fix the KB.
