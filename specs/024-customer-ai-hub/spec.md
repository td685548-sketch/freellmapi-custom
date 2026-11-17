# Feature Specification: Customer AI Hub, Smart Personal-Key Routing & Dual-Persona Quota/Anomaly Intelligence

**Feature Branch**: `feat/024-customer-ai-hub`
**Created**: 2026-11-18
**Status**: In Implementation

## Problem Statement

FreeLLMAPI has rich AI Platform capabilities on the administrator side (`/ai-platform`, MCP, Orchestrator, Retrieval, Output Guard, Service Desk), while customer (`member` and `guest`) experiences are limited to basic personal key minting and raw Playground chat. Customers need immediately useful, low-friction AI capabilities without exposing internal system prompts, provider credentials, or upstream failure details, while administrators need authoring, audience gating, adoption metrics, and cross-account anomaly mitigation.

## User Stories

### US1 — Customer AI Assistants Hub & Session Chat (`/assistants`)
- As a signed-in customer (`member`), I can browse published AI Assistants filtered by category (`coding`, `writing`, `data`, `productivity`, `general`), inspect their starter prompts and recommended routing mode (`Eco`, `Balanced`, `Max`), and chat with any accessible assistant directly in the browser.
- Security invariant: internal `systemPrompt` instructions and the unified gateway API key are NEVER exposed in customer/guest API responses or browser network calls.

### US2 — Guest Catalog Preview (`guest` opt-in)
- As a signed-out visitor (`guest`) when an administrator enables the `view_assistants` guest permission, I can browse `guest_preview` assistants (cards, category, recommended routing mode, starter prompts) on `/assistants`, and attempting to chat prompts me to sign in or request access.

### US3 — Personal API Key Presets, Custom Instructions & Smart Routing (`sk-flm-…`)
- As a signed-in customer, I can bind an active `sk-flm-…` key to an AI Assistant preset and choose a per-key routing mode (`default`, `eco`, `balanced`, `max`).
- I can configure personal Custom Instructions (max 2,000 chars) and toggle whether they automatically apply to my personal API keys.
- At inference time (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`), `eco` maps to `fastest`, `balanced` to `balanced`, and `max` to `smartest`, and the assistant's prompt + optional custom instructions are prepended server-side.

### US4 — Customer AI Quota & Routing Coach
- As a signed-in customer, I see personalized quota & routing recommendations calculated from my own usage history and active personal keys, with a 1-click **"Switch to Eco"** action to conserve monthly quota.

### US5 — Administrator Assistants Studio & Fleet Anomaly Radar (`/ai-platform/customer-ai` & Admin mode on `/assistants`)
- As an administrator with appropriate `manage_ai_platform` leaf permissions (`view_prompts`, `edit_prompts`, `view_ai_platform`, `edit_ai_flags`), I can create, edit, enable/disable, target (`guest_preview`, `all_members`, `admin_only`), and delete AI Assistants, inspect adoption metrics (`boundKeysCount`, `playgroundRuns`), monitor fleet anomalies (`token_spike`, `high_error_loop`, `unoptimized_heavy_usage`), and apply 1-click Eco mode mitigation to anomalous accounts.

## Non-Functional & Compliance Requirements
- **Zero-Conflict Modularity**: All new logic resides in `shared/customer-ai.ts`, `server/src/custom/customer-ai/`, `client/src/custom/customer-ai/`, and a new timestamped migration. Existing upstream files receive only minimal hook points.
- **Reversible Migration**: `user_api_keys` column additions omit foreign key `REFERENCES` / indexes so SQLite `DROP COLUMN` roundtrip tests pass cleanly.
- **Bilingual i18n**: Every `tc('...')` literal has a matching Vietnamese translation in `client/src/custom/i18n/vi.ts`.
