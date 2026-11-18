# Feature Specification: Scenario-Based Auto-Routing for Coding Agents & 1-Click IDE Config Packager

**Feature Branch**: `feat/039-scenario-routing-ide-packager`  
**Created**: 2026-11-18  
**Status**: Implemented  

## 1. Overview & Motivation

Modern AI coding agents (Claude Code, Cursor, Cline, Roo Code, Codex CLI, OpenCode, Continue) emit heterogeneous LLM requests during a single coding session:
- **Background utility requests**: short conversation title/topic generation, git commit message generation, context compaction/summarization, and tiny classification probes — which otherwise burn expensive Frontier/Max quota unnecessarily.
- **Deep reasoning (`think`) turns**: explicit extended thinking (`thinking.type = "enabled"`, `reasoning_effort`, `reasoning.effort`) or complex architecture/debugging root-cause prompts that benefit from highest-intelligence models (`max` tier).
- **Long-context (`longContext`) payloads**: repository dumps exceeding 60K+ input tokens that require large context windows.
- **Multimodal (`vision`) & Search (`webSearch`) turns**: image-bearing turns and web-search tool turns.

Inspired by `claude-code-router`'s ordered `RoutePolicyEngine` and `OmniRoute`'s synchronous `<1ms` multilingual `intentClassifier`, Spec 039 adds a zero-latency **Scenario-Based Auto-Routing Engine** with per-user / per-personal-key policy toggles and cumulative high-tier quota savings telemetry, paired with a **1-Click Personalized IDE Config Packager & Live Connection Verifier** so members and operators can connect any coding agent in seconds and verify connectivity live.

## 2. User Scenarios & Acceptance Criteria

### US1 — Deterministic Zero-Latency Request Scenario Classification (P1)
- **Given** an incoming `POST /v1/chat/completions`, `POST /v1/messages`, or `POST /v1/responses` request,
- **When** the Scenario Auto-Routing middleware inspects the parsed JSON payload,
- **Then** it deterministically classifies the request in `<1ms` with zero external LLM calls into one of six scenarios: `vision`, `webSearch`, `longContext`, `background`, `think`, or `default`.

### US2 — Per-User & Per-Key Scenario Policy Overrides with Safe Fallback (P1)
- **Given** an authenticated member or admin with a configured Scenario Policy (account-wide or scoped to a specific Personal API Key `sk-flm-...`),
- **When** a matching scenario is enabled (e.g., `background -> eco`, `think -> max`, `longContext -> balanced` or a specific catalog model),
- **Then** the request is steered via `setRequestKeyRoutingPreset` (and optional validated `targetModel`), safely falling back to tier routing if a configured `targetModel` is disabled, lacks usable keys, or cannot satisfy vision/context constraints — never breaking OpenAI/Anthropic/Responses streaming or non-streaming wire shapes.

### US3 — Cumulative Scenario Hit Telemetry & Estimated High-Tier Quota Saved (P2)
- **Given** scenario-routed inference traffic on a user's keys,
- **When** `background` or `default` requests are routed to `eco` tier instead of high-tier models,
- **Then** `custom_scenario_routing_stats` records hit counts, total tokens, and estimated high-tier quota tokens saved, surfaced in `ScenarioRouterPanel` and `PersonalKeyPanel`.

### US4 — 1-Click Personalized IDE Config Packager & Live Connection Verifier (P1)
- **Given** a signed-in user viewing the Agents page or Personal Key Panel,
- **When** they select an active Personal API Key (or mint/paste one) and choose an IDE/CLI (`Claude Code`, `Cursor`, `Cline / Roo Code`, `Codex CLI`, `OpenCode`, `Continue`),
- **Then** they can 1-click Copy or Download ready-to-use config files and PowerShell/Bash setup one-liners, and click **"Verify IDE Connection"** (backed by `POST /api/scenario-routing/verify-ping` and recent key activity polling) which lights up green upon live ping or IDE traffic.

## 3. Security & Zero-Conflict Requirements
- **Strict User Isolation**: Every policy, key list, IDE snippet, verification ping, and telemetry query in `/api/scenario-routing/*` is strictly scoped to `req.user.userId` (admins may optionally inspect aggregate telemetry via admin-gated endpoint, never leaking raw secrets).
- **Zero-Conflict Surface**: Do not modify `PERMISSION_GATES` in `server/src/custom/register.ts` or shared i18n dictionaries; enforce `requireAuth` + non-guest checks directly inside `server/src/custom/scenario-routing/router.ts`, and store bilingual VI/EN copy in `client/src/custom/scenario-routing/strings.ts`.
- **Reversible Migration**: `20261118_190000_custom_scenario_routing.ts` includes `// DOWN: reversible` with idempotent `up(db)` and `down(db)`.
