# Feature Specification: Provider Quota and Three-Tier Fallback
**Branch**: feat/9router-integration
**Created**: 2026-11-07
**Status**: Ready
**Input**: Add real provider quota tracking, reset countdown and Subscription → Cheap → Free fallback based on 9Router.

## User Scenarios & Testing
### US1 — Real quota (P1)
Operators open Quota, refresh account data and see provider-reported limits, remaining allowance, source and observation time.
**Why**: Local usage cannot reveal remaining provider allowance.
**Independent test**: Refresh mocked Groq/Claude/Codex/Copilot/OpenRouter/DeepSeek responses and verify quota values without leaking credentials.
**Acceptance**: Missing fields show unknown; failed refresh preserves last-known observations but marks errors/staleness; custom base URLs never receive credentials at official quota endpoints.
### US2 — Reset countdown (P1)
Operators see live reset countdown for each provider window.
**Why**: Know when capacity may recover.
**Independent test**: Advance time past reset; show awaiting refresh, never invent replenishment.
### US3 — Three-tier fallback (P1)
Auto routing tries subscription, then cheap, then free accounts. Operators can override each account's tier.
**Why**: Prefer existing subscriptions while retaining backup capacity.
**Independent test**: Seed all three tiers; exhausted fresh account is skipped; stale/unknown data does not permanently block; combo order stays explicit.
### Edge Cases
No accounts, disabled account, 429 with/without Retry-After, missing quota API, stale snapshots, model-scoped limits, failed refresh, malformed data, expired credentials, duplicate polling and account deletion.

## Requirements
- FR1: Dedicated Quota view with provider/account filters, remaining bars, timestamps, refresh and English/Vietnamese labels.
- FR2: Only provider data is presented as real quota; internal monthly caps are labeled separately.
- FR3: Read-only quota probes use encrypted credentials and configured proxy, timeouts and throttled/coalesced refreshes; never send inference probes or reset/consume quota credits.
- FR4: Persist snapshots separately from upstream provider keys; deletion cascades. Expose no secrets or raw provider payloads.
- FR5: Countdown uses provider reset timestamps; expired observations require refresh.
- FR6: Auto routing uses three-tier order and fresh account-wide exhausted windows. Explicit model/provider and combo routing keep their intent while respecting confirmed exhaustion.
- FR7: Refresh needs view_x_usage; tier changes need edit_x_settings; anonymous/unauthorized users are rejected server-side.
- FR8: Automated integration, UI and migration roundtrip tests are required.
### Key Entities
Account quota snapshot: windows with source, remaining, limit, unit, reset, observation and scope. Routing policy: account tier override.

## Success Criteria
- SC1: Supported provider fixtures yield exact limits/remaining/reset values.
- SC2: Countdown advances without refetching every second and switches to awaiting refresh at zero.
- SC3: All three tiers route in order; exhausted accounts are skipped only while evidence is valid.
- SC4: Credential-isolation and authorization tests pass; existing routes remain compatible.

## Assumptions
Provider support varies. Initial official adapters cover Claude, Codex, Copilot, OpenRouter, DeepSeek and Groq headers; other providers show unknown until inference headers or a future adapter supplies data. Tier is routing policy, not a pricing guarantee. No paid quota resets or auto-ping.
