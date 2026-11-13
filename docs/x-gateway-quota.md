# X Gateway Quota

Open **X Gateway → Quota** (`/thruline/quota`). The page requires `use_x_gateway` and `view_x_usage`. Changing routing tiers additionally requires `edit_x_settings`.

Use **Refresh quota** for one account or **Refresh supported accounts** for all enabled supported accounts. Optional automatic refresh runs once per minute while the tab is visible. Repeated refreshes within 30 seconds reuse the last check; concurrent refreshes for the same account share one request. Probes use the account's configured outbound proxy and a ten-second timeout. They do not send chat requests, warm quota windows or consume reset credits.

Supported provider APIs:

| Provider | Data |
| --- | --- |
| Claude | Session and weekly utilization/reset windows; model-specific windows are displayed separately |
| Codex | Primary and secondary rate-limit utilization/reset windows |
| GitHub Copilot | Chat, completion and premium interaction allowances; requires a GitHub OAuth connection |
| OpenRouter | Key credit limit and remaining allowance, when the key has a reported limit |
| DeepSeek | Available balance by currency |
| Groq | Request/token rate-limit headers from the models endpoint, when supplied |

OpenAI-style and Anthropic-style rate-limit headers from normal X Gateway inference are also recorded. These observations are scoped to the model that produced them, so an exhausted model does not disable every other model on an account. Quota probes use fixed official endpoints; credentials for custom base URLs are never sent to those endpoints.

No data means **Unknown**, not unlimited. A failed refresh preserves the last observation and shows an error. Observations are considered fresh for five minutes, or until their reported reset time passes. A reset countdown reaching zero means **refresh to confirm**; the application does not invent renewed capacity. Provider-specific support depends on the token's permissions and the provider's response.

**Local monthly usage / configured cap** shows internal request/token counts separately. These values cannot establish a provider's remaining quota.

For `model: "auto"`, X Gateway tries **Subscription → Cheap → Free** accounts. Defaults come from provider categories, with per-account overrides on the Quota page. Tiers are routing preferences, not a price guarantee. Fresh account-wide exhaustion removes an account from routing; fresh model-specific exhaustion skips that model at dispatch. HTTP 429 responses apply the provider's Retry-After cooldown, or a 60-second fallback cooldown if none is reported. Stale evidence stops blocking and can be refreshed.

Explicit provider/model requests retain their provider. Named combos retain their configured step order; confirmed exhausted routes are skipped. A quota failure never bypasses local caps or authentication. Main `/v1` routing remains separate.

Snapshots and tier overrides live in dedicated tables linked only to `x_gateway_keys`, with cascading deletion. API responses contain normalized quota values, account labels, timestamps and generic errors; credentials and raw provider payloads are excluded.
