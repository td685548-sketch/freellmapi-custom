**English** · [简体中文](../../zh-cn/compression/02-output-savers.md)

# Output savers (caveman and ponytail)

[← Back to README](../README.md) · [Documentation index](../README.md) · [API reference](../api/01-rest-api.md)

Compression shrinks what you send. The two output savers shrink what comes **back**: they
prepend a fixed style instruction so the model answers in fewer words (`caveman`) and writes
less code (`ponytail`). Both are **off by default**, and neither touches routing, provider
choice, tools, or the conversation itself — only the wording of the answer.

## The two savers

| Saver | What it changes |
| --- | --- |
| `caveman` | Prose terseness. Filler, hedging and pleasantries go; the sentence-level compression deepens with the level. |
| `ponytail` | Code minimalism. The model works a ladder before writing anything — does it need to exist, does the stdlib do it, does the platform cover it, is one line enough — and ships the shortest diff it can. |

Each takes a level:

| Level | `caveman` | `ponytail` |
| --- | --- | --- |
| `off` | Nothing injected. This is the default, and a request header cannot enable a saver the operator left off. | Nothing injected. |
| `lite` | Terse but grammatical: full sentences, filler dropped. | Builds what was asked and names the lazier alternative in one line; you decide. |
| `full` | Caveman compression: articles and hedging gone, fragments fine, every technical term exact. | The ladder enforced — stdlib and native first, shortest diff, shortest explanation. |
| `ultra` | Maximum compression; one word when one word is enough. | YAGNI extremist: delete before add, ship the one-liner and challenge the rest of the request in the same answer. |

Both levels of both savers carry the same guardrails, so terseness never costs correctness:
code blocks, file paths, commands, error strings and URLs stay exact; security warnings,
irreversible-action confirmations and multi-step sequences revert to normal prose; the user's
dominant language is preserved; nothing is invented as an abbreviation; and the style is never
announced in the answer. `ponytail` never simplifies away input validation at trust boundaries,
error handling that prevents data loss, security, accessibility, or anything explicitly requested.

The instruction text is a constant in the source
(`server/src/custom/output-savers/prompts.ts`, adapted from 9Router under MIT). Neither the
settings API nor a request header can put arbitrary text into the injected system message —
you choose a level, not a prompt.

## Enable it

Bootstrap with environment variables:

```env
FREELLMAPI_CAVEMAN=full
FREELLMAPI_PONYTAIL=lite
```

or at runtime, without a restart:

```bash
curl -X PUT http://localhost:3000/api/savers \
  -H "Authorization: Bearer <dashboard session token>" \
  -H "Content-Type: application/json" \
  -d '{"caveman":"full","ponytail":"off"}'
```

`GET /api/savers` reads the same view. Authenticated admin clients can use both; a write needs
the system-settings capability (`manage_compression` leaf or the `manage_settings` parent), a
read is open to any signed-in account so a status view can show what is active.

A stored setting takes precedence over the environment, exactly as it does for compression:
the env value only decides a saver that has never been written through the API. A write from
this process applies on the next request; a write from another process or another node lands
within five seconds.

There is no dashboard page for savers yet — the API and the two environment variables are the
whole control surface.

## Per-request control

Send `X-FreeLLM-Saver` on any chat request:

```text
X-FreeLLM-Saver: off
X-FreeLLM-Saver: lite
X-FreeLLM-Saver: caveman=off
X-FreeLLM-Saver: caveman=lite,ponytail=off
```

`off` bypasses both savers for that request, a bare level is a **ceiling** for both, and
`name=level` sets one saver. A header can lower or disable a saver but never raise one and
never enable one the operator kept off — the same one-way rule as `X-FreeLLM-Compress`.
A value that cannot be parsed is ignored and the configured levels stand.

## Where the text goes

* One **new** system message at the front of `messages`. The caller's own system message is
  never edited, so an agent that sends a byte-identical prefix keeps its provider-side prompt
  cache hit.
* A client profile's server-enforced prompt still comes first: enforced prompt, then savers,
  then the caller's system message.
* Injection runs **after** compression, so the saver text is never itself compressed and the
  compression statistics keep describing your payload.
* The block is part of `messages`, so token estimation, context-window budgets and the response
  cache key all see it. A cached terse answer is never replayed to a request that did not ask
  for one.
* It is idempotent: a retried or replayed body that already carries the block is not injected
  a second time.
* Fail-open. Anything unexpected leaves the conversation untouched — a style nicety must never
  be the reason a request breaks.

Savering runs on every chat wire: `/v1/chat/completions`, the legacy `/v1/completions`,
`/v1/responses`, `/v1/messages` (Anthropic), and Gemini `generateContent` /
`streamGenerateContent`. Token-counting endpoints are deliberately not savered: they should
report what the caller actually sent.

## What it costs

The block is injected into **every** request while a saver is on, and it is a few hundred to a
few thousand characters. `GET /api/savers` reports it:

```json
{
  "caveman": "full",
  "ponytail": "lite",
  "sources": { "caveman": "setting", "ponytail": "env" },
  "injectedChars": 3182
}
```

`sources` says where each level came from (`setting`, `env`, or `default`), and `injectedChars`
is what one extra request now carries — the same `chars / 4` estimate used elsewhere divides it
into tokens. Against an answer that comes back 30–50% shorter it is usually a good trade, but
on a one-line question it is pure overhead: that is what the per-request header is for.

## Related

- [01-compression-pipeline.md](01-compression-pipeline.md) — the input-side half of the same budget.
- [../api/01-rest-api.md](../api/01-rest-api.md) — request and response headers.
- [../env/01-variables.md](../env/01-variables.md) — `FREELLMAPI_CAVEMAN` and `FREELLMAPI_PONYTAIL`.
