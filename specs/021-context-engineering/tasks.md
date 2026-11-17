---

description: "Task list for 021 context engineering (token-budgeted context assembly)"
---

# Tasks: Lắp ráp ngữ cảnh có ngân sách token (Context Engineering)

**Input**: Design documents from `specs/021-context-engineering/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Bắt buộc. Hiến pháp nguyên tắc IV yêu cầu mọi tính năng có test; trong từng phase, viết test trước và xác nhận test **thất bại** trước khi triển khai.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

**Quy tắc chung cho mọi task** (đọc trước khi làm):
- Zero-conflict (Hiến pháp VI): logic mới chỉ nằm trong `server/src/custom/context-budget/`, `server/src/routes/context-policy.ts`, `shared/context-budget.ts`, `client/src/custom/Context*.tsx`. File upstream (`routes/proxy.ts`, `routes/anthropic.ts`, `routes/responses.ts`, `lib/inbound-chat.ts`) chỉ nhận đúng các dòng móc nêu trong T026–T029; không định dạng lại, không refactor.
- Khi chính sách tắt, mọi hàm mới phải là no-op: trả nguyên tham chiếu/giá trị đầu vào, không đặt header, không ghi DB.
- Không ghi nội dung tin nhắn vào log hoặc bảng báo cáo.
- Test server đặt dưới `server/src/__tests__/`, chạy bằng `npm run test -w server -- <path>`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Kiểu dùng chung và khung thư mục

- [ ] T001 Tạo thư mục `server/src/custom/context-budget/` và `server/src/__tests__/custom/context-budget/fixtures/`; thêm `server/src/custom/context-budget/README.md` mô tả hai giai đoạn (thu thập ở gate, khớp ở dispatch) và liên kết tới `specs/021-context-engineering/plan.md`
- [ ] T002 [P] Tạo `shared/context-budget.ts` với: `ContextPreset = 'saver' | 'balanced' | 'max_context' | 'custom'`; `ClientHistoryMode = 'passthrough' | 'trim_on_overflow' | 'enforce_budget'`; `ContextPolicy` (các trường camelCase của bảng `custom_context_policies` trong data-model.md mục 1, thêm `inherited: boolean`); `ContextPolicyInput` (mọi trường tùy chọn); `ContextPolicyDefault { enabled; preset; fallbackWindowTokens; imageTokens }`; `CONTEXT_PRESETS` đúng bảng research.md R8 (saver: 8000/1024/10/15/20/4/true; balanced: 16000/1024/10/15/25/4/true; max_context: null/2048/10/10/30/8/true; tất cả `clientHistoryMode: 'passthrough'`); `CONTEXT_POLICY_LIMITS` = { minMaxInputTokens: 2000, maxMaxInputTokens: 1000000, outputReserve: [128, 32768], safetyMarginPct: [0, 30], sharePct: [0, 60], maxShareSum: 80, dropBlockTurns: [1, 16], knowledgeMinScore: [0, 1], fallbackWindowTokens: [1024, 1000000], imageTokens: [85, 4096] }; `CONTEXT_POLICY_DEFAULT = { enabled: false, preset: 'balanced', fallbackWindowTokens: 8192, imageTokens: 765 }`; `ContextAssemblySummary` (các khóa của header trong contracts/context-metadata.md mục 1 + `estimatedTokens`, `heuristicTokens`, `modelKey`, `createdAt`); `ContextStats` (dạng trả về trong contracts/context-policy-api.md mục 2); `ContextPreview` (mục 3)
- [ ] T003 [P] Tạo bộ dựng dữ liệu test `server/src/__tests__/custom/context-budget/fixtures/conversations.ts`: hàm `makeConversation({ turns, lang: 'en' | 'vi' | 'zh', withToolCalls?, seed })` sinh `ChatMessage[]` xác định (deterministic) và `makeFactRecallScenario()` trả 20 sự kiện (tên, số, mã đơn, ngày) + 120 lượt đệm + 20 câu hỏi kèm đáp án mong đợi

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Lược đồ, chính sách, ước lượng token, phân loại phân đoạn và thuật toán khớp ngân sách thuần. Mọi user story phụ thuộc phase này.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Lược đồ

- [ ] T004 Tạo migration `server/src/db/migrations/20261117_100000_custom_context_budget.ts` theo mẫu `server/src/db/migrate/TEMPLATE.ts` và kiểu `hasTable`/`hasColumn` của `20261107_000009_custom_conversation_summary.ts`. `up`: (a) `CREATE TABLE IF NOT EXISTS custom_context_policies` với các cột đúng data-model.md mục 1: `profile_id INTEGER PRIMARY KEY`, `enabled INTEGER NOT NULL DEFAULT 0`, `preset TEXT NOT NULL DEFAULT 'balanced'`, `max_input_tokens INTEGER` (NULL = không trần), `output_reserve_tokens INTEGER NOT NULL`, `safety_margin_pct INTEGER NOT NULL`, `summary_share_pct INTEGER NOT NULL`, `knowledge_share_pct INTEGER NOT NULL`, `drop_block_turns INTEGER NOT NULL`, `summarize INTEGER NOT NULL DEFAULT 1`, `client_history_mode TEXT NOT NULL DEFAULT 'passthrough'`, `knowledge_min_score REAL`, `updated_at TEXT NOT NULL`; (b) `CREATE TABLE IF NOT EXISTS custom_context_reports` đúng data-model.md mục 4 (`request_id INTEGER PRIMARY KEY`, …, `created_at TEXT NOT NULL`) và `CREATE INDEX IF NOT EXISTS idx_custom_context_reports_profile ON custom_context_reports(profile_id, created_at)`; (c) nếu có bảng `custom_conversations` và chưa có cột thì `ALTER TABLE custom_conversations ADD COLUMN context_window_start_id INTEGER` (mặc định NULL). `down`: đảo ngược đủ cả ba. Không trigger
- [ ] T005 Đăng ký migration: thêm import và dòng `{ filename: '20261117_100000_custom_context_budget.ts', module: … }` cuối danh sách trong `server/src/db/migrate/defaults.ts`; thêm tên file vào danh sách mong đợi trong `server/src/__tests__/db/migrate/roundtrip.test.ts` và `server/src/__tests__/db/turso-read-cache.test.ts`
- [ ] T006 [P] Viết `server/src/__tests__/db/migrate/context-budget.test.ts` (mẫu: `ai-platform-mcp-profile-cleanup.test.ts`): up tạo đủ 2 bảng + index + cột; chạy up hai lần không lỗi; down xóa sạch; dữ liệu hội thoại cũ còn nguyên sau up/down

### Chính sách

- [ ] T007 [P] Viết test `server/src/__tests__/custom/context-budget/policy.test.ts` cho `policy.ts`: key không có dòng → `inherited: true` theo mặc định hệ thống; mặc định hệ thống khi khóa `context_policy_default` chưa có = `CONTEXT_POLICY_DEFAULT`; `preset` khác `custom` ghi đè trường số bằng giá trị mức đặt sẵn và từ chối trường số lệch (`context_policy_preset_mismatch`); `maxInputTokens < 2000` → `context_policy_budget_too_small`; `summarySharePct + knowledgeSharePct > 80` → `context_policy_shares_too_large`; ngoài giới hạn hoặc trường lạ → `context_policy_invalid`; bộ đệm theo `profile_id` bị xóa khi ghi; `suggestedFromConversationSettings({ maxChars: 12000, summarize: true })` → `maxInputTokens` = làm tròn lên bội 1.000 của 12000/3,2 = 4000, tối thiểu 2000
- [ ] T008 Triển khai `server/src/custom/context-budget/policy.ts`: `resolveContextPolicy(profileId): ContextPolicy` (đọc `custom_context_policies`, rơi về mặc định hệ thống từ `settings` khóa `context_policy_default`, bộ đệm `Map` theo profile, xóa khi ghi); `getContextPolicyDefault()`/`setContextPolicyDefault()`; `saveContextPolicy(profileId, input)` dùng zod theo `CONTEXT_POLICY_LIMITS` với các mã lỗi ở T007; `deleteContextPolicy(profileId)`; `suggestedFromConversationSettings()`; `pruneOrphanPolicies()` xóa dòng của key không còn trong `client_profiles`. Kiểu lấy từ `@freellmapi/shared/context-budget.js`

### Ước lượng token

- [ ] T009 [P] Viết test `server/src/__tests__/custom/context-budget/estimate.test.ts`: chuỗi ASCII 400 ký tự ≈ 100 token; chuỗi tiếng Việt có dấu 250 ký tự ≈ 100 token; 100 ký tự CJK ≈ 100 token; mỗi tin cộng 4 token; khối ảnh cộng `imageTokens`; `tool_calls` tính tên + đối số; định nghĩa tools tính theo JSON; `heuristicTokens()` cho kết quả bằng đúng `estimateInputTokens()` của `server/src/lib/content.ts`; hệ số hiệu chỉnh: sau 50 mẫu tỷ lệ 1,2 thì hệ số tiến về ~1,2, luôn kẹp trong [0,75; 1,6]; nền tảng chưa có mẫu → 1,0
- [ ] T010 Triển khai `server/src/custom/context-budget/estimate.ts` theo research.md R4: `estimateTextTokens(text)`, `estimateMessageTokens(m, imageTokens)`, `estimateMessagesTokens(messages, { tools?, imageTokens, platform? })` (nhân hệ số hiệu chỉnh của nền tảng khi có), `heuristicTokens(messages, tools)` (gọi lại `estimateInputTokens`), `charsPerToken(text)` (dùng để quy trần tri thức ra ký tự), `recordCalibrationSample(platform, providerTokens, estimatedTokens)` (EMA α = 0,1, kẹp [0,75; 1,6]), `resetCalibration()` cho test. Phân nhóm ký tự: ASCII /4; Latin có dấu U+00C0–U+024F, U+1E00–U+1EFF, dấu kết hợp U+0300–U+036F /2,5; CJK/kana/hangul /1; còn lại /3

### Sổ đăng ký và phân loại

- [ ] T011 [P] Triển khai `server/src/custom/context-budget/registry.ts`: `WeakMap<Request, SegmentRegistry>`; `getRegistry(req)`, `createRegistry(req, policy)`; `registerUnit(req, { kind: 'summary' | 'knowledge' | 'history', role, text, seq, messageId? })` tự tính `fingerprint` = 16 ký tự hex đầu của SHA-1 trên `contentToString` đã `normalize('NFC').trim()` và `tokens`; trường `conversation`, `base`, `lastOutput`, `windowStartMessageId`, `report`, `refits`, `trace` theo data-model.md mục 5
- [ ] T012 [P] Viết test `server/src/__tests__/custom/context-budget/segments.test.ts`: tin system/developer không đăng ký → `mandatory`; tin người dùng cuối và chuỗi `assistant(tool_calls)` + các `tool` theo sau tin người dùng cuối → `mandatory`; một `assistant(tool_calls)` cùng mọi `tool` kết quả của nó luôn chung một segment; tin ghép được theo (role, fingerprint) → đúng `kind`/`seq` đã đăng ký; tóm tắt/tri thức nằm **bên trong** tin system đầu (trường hợp Anthropic) được nhận theo chuỗi con và tách thành segment riêng có `indexes` trỏ vào tin đó cùng khoảng ký tự; tin không ghép được → `client_history` với `seq` = chỉ số trong mảng gốc
- [ ] T013 Triển khai `server/src/custom/context-budget/segments.ts`: `classifySegments(messages, registry): ContextSegment[]` theo T012 và research.md R5/R6

### Thuật toán khớp ngân sách (thuần, không I/O)

- [ ] T014 [P] Viết test `server/src/__tests__/custom/context-budget/fit.test.ts` cho `fitToBudget()`: (1) `effectiveBudget = min(maxInputTokens ?? ∞, floor((contextWindow − outputReserve) × (1 − safetyMarginPct/100)))` — biên an toàn không trừ vào `maxInputTokens`; ví dụ cửa sổ 8.000, reserve 1.000, biên 10%, trần 32.000 → 6.300; cửa sổ null dùng `maxInputTokens`, cả hai null dùng `fallbackWindowTokens`; (2) thứ tự bỏ: lịch sử cũ nhất → khối tri thức → tóm tắt (cắt ở ranh giới câu trước, rồi bỏ hẳn); (3) phần bắt buộc không bao giờ bị bỏ; vượt thì trả `{ ok: false, reason: 'mandatory_exceeds', mandatoryTokens, budget }`; (4) trần tóm tắt = `summarySharePct% × (budget − mandatory)`, trần tri thức tương tự, phần dư nhường cho lịch sử; (5) lịch sử bỏ theo khối `dropBlockTurns` lượt, điểm bắt đầu neo vào bội số khối theo `seq`: với block 4 và hội thoại tăng dần từng lượt, điểm bắt đầu giữ nguyên qua ít nhất 3 lượt liên tiếp rồi mới nhảy đúng 4 lượt; (6) sau khi bỏ, lượt đầu còn lại là trợ lý thì bỏ tiếp tới lượt người dùng; (7) cặp tool call/kết quả không bao giờ bị tách; (8) `client_history` chỉ bị bỏ khi `clientHistoryMode ≠ 'passthrough'`; với `trim_on_overflow` budget bỏ qua `maxInputTokens`; với `passthrough` nếu phần ghim làm vượt trần key thì bỏ hết đơn vị gateway rồi trả `ok` nếu vừa cửa sổ (FR-009 ngoại lệ); (9) kết quả gồm mảng mới, số token theo loại, số đã gửi/bỏ của từng loại, `windowStartMessageId`, `knowledgeDropped`
- [ ] T015 Triển khai `server/src/custom/context-budget/fit.ts`: `fitToBudget({ messages, segments, policy, contextWindow, outputReserve, fallbackWindowTokens }): FitResult` theo T014, research.md R6/R7/R11. Không truy cập DB, Express hay đồng hồ

**Checkpoint**: Nền tảng xong — `fitToBudget` được test độc lập; các user story có thể bắt đầu

---

## Phase 3: User Story 1 - Mỗi yêu cầu được lắp ráp trong một ngân sách token chung (Priority: P1) 🎯 MVP

**Goal**: Key bật chính sách: mọi request dùng hội thoại phía server được khớp vào ngân sách của model thực sự phục vụ, khớp lại khi fallback, từ chối rõ ràng khi phần bắt buộc quá lớn; key tắt chính sách không đổi gì.

**Independent Test**: quickstart.md mục 2–5 (ngân sách 4.000, phát lại 300 lượt; đổi sang model 8k; tin 30.000 token; chính sách tắt).

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T016 [P] [US1] Viết `server/src/__tests__/custom/context-budget/hooks.test.ts`: chính sách tắt → `contextRoutingTokens` trả nguyên số, `fitContextForRoute` trả **cùng tham chiếu** mảng; bật → `contextRoutingTokens` trừ đi phần có thể bỏ (theo ký tự/4); `fitContextForRoute` gọi lần 2 với chính mảng đã trả ở lần 1 thì khớp lại từ `base` (route lần 2 có cửa sổ lớn hơn lấy lại được lịch sử đã bỏ); gọi với mảng mới thì mảng đó thành `base`; phần bắt buộc vượt cửa sổ route → ném lỗi có `providerRejection: 'request'` và thông điệp chứa `exceeds this model's context window`; `refits` tăng mỗi lần khớp ở route khác; phần dành cho câu trả lời: request **có** `max_tokens` → dùng `outputReserve` của surface, request **không có** → dùng `policy.outputReserveTokens` (FR-007); cờ `fitted` chỉ bật sau lần khớp đầu tiên
- [ ] T017 [P] [US1] Viết `server/src/__tests__/custom/context-budget/gate.test.ts` (mẫu kiểm thử: `server/src/__tests__/custom/profile-conversations.test.ts`): với `X-Conversation-Id` và chính sách bật, lịch sử ứng viên được nạp vượt `conv_max_chars` cũ nhưng vẫn ≤ `conv_max_messages`, mỗi tin được đăng ký với `messageId`; tóm tắt được đăng ký; phần bắt buộc > `maxInputTokens` → 400 `context_budget_exceeded` kèm header `X-FreeLLM-Context: budget=…;mandatory=…`, trên `/v1/chat/completions` dạng `{ error: { message, type: 'invalid_request_error', code: 'context_budget_exceeded', param: 'messages' } }` và trên `/v1/messages` dạng `{ type: 'error', error: { type: 'invalid_request_error', message } }`; ở chế độ `passthrough`, lịch sử do client gửi không tính vào kiểm tra này; kiểm tra so với ngân sách tạm ở gate (research.md R7: `W_max` = cửa sổ lớn nhất trong model key được phép, có tôn trọng allowlist); `clientMaxTokens` được ghi đúng cho cả 4 tên trường; hai request đồng thời cùng `X-Conversation-Id` đều thành công và mỗi request chỉ thấy dữ liệu đã lưu lúc nó đến (không thấy tóm tắt viết dở); hội thoại bị xóa giữa hai lượt được phục vụ như hội thoại mới, không lỗi; trên Gemini lỗi có dạng `{ error: { code: 400, message, status: 'INVALID_ARGUMENT' } }`
- [ ] T018 [P] [US1] Viết `server/src/__tests__/custom/context-budget/regression.test.ts` (SC-006): với key không bật chính sách, thân request mà provider giả nhận được trên cả 4 surface (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, Gemini `:generateContent`) giống hệt byte-for-byte khi chạy với module context-budget bị thay bằng no-op; không có header `X-FreeLLM-Context`; `X-Conversation-History` như cũ
- [ ] T019 [P] [US1] Viết `server/src/__tests__/custom/context-budget/surfaces.test.ts`: hai model giả (cửa sổ 8.192 và 131.072), model lớn đứng trước và trả lỗi 503; với ngân sách key 16.000 và hội thoại phía server 200 lượt (`X-Conversation-Id`) trên **`/v1/chat/completions` và `/v1/messages`** — hai wire duy nhất hỗ trợ hội thoại phía server; `/v1/responses` và Gemini được kiểm tra khớp lại ở T055 bằng lịch sử do client gửi — request thành công qua model nhỏ, thân gửi tới model nhỏ có tổng ước lượng ≤ ngân sách hiệu lực của nó, header có `refits=1`; không surface nào trả "không có model phù hợp"

### Implementation for User Story 1

- [ ] T020 [US1] Thêm vào `server/src/services/profile-conversations.ts` hàm `loadHistoryCandidates(profileId, key, endUser, s, { maxMessages, maxChars }, now)` trả giống `loadHistory` nhưng mỗi tin có `id`, áp trần do bộ gọi truyền vào; giữ nguyên `loadHistory` cũ cho nhánh chính sách tắt
- [ ] T021 [US1] Triển khai `server/src/custom/context-budget/gate.ts`: `prepareContextBudget(req, profileId)` (giải quyết chính sách; tắt → không làm gì; bật → `createRegistry`); `historyCandidateLimits(policy, settings)` = `{ maxMessages: settings.maxMessages, maxChars: (policy.maxInputTokens ?? 1_000_000) × 4 }`; `registerHistory(req, rows)`, `registerSummary(req, text)`; `prepareContextBudget` cũng ghi `clientMaxTokens` (đọc `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `generationConfig.maxOutputTokens` trong body; không có thì null) và tính `provisionalBudget` theo research.md R7 (dùng `servableContextWindow` của `server/src/services/model-listing.ts` trên các model khả dụng mà key được phép); `checkMandatoryBudget(req, res, wire)` ước lượng phần bắt buộc (tin system/developer + tin người dùng cuối + chuỗi công cụ đang dở), lưu vào `registry.mandatoryTokens`, và trả lỗi `context_budget_exceeded` theo contracts/context-metadata.md mục 2 (dạng lỗi theo `wire`: `openai-chat`/`responses` → OpenAI, `anthropic` → Anthropic, `gemini` → Google) khi vượt `provisionalBudget`
- [ ] T022 [US1] Sửa `server/src/custom/conversation-inject.ts`: khi `getRegistry(req)` tồn tại, dùng `loadHistoryCandidates` với `historyCandidateLimits`, gọi `registerHistory`/`registerSummary` cho từng phần đã chèn; nhánh tắt giữ nguyên từng dòng hiện có. Header `X-Conversation-History` khi bật được cập nhật ở T025 (số tin thực sự gửi)
- [ ] T023 [US1] Sửa `server/src/middleware/profile-gate.ts`: gọi `prepareContextBudget(req, profile.id)` ngay trước khối `if (!internalCall) { if (!applyConversation(…)) return; … }` (chỉ khi `!internalCall`), và gọi `checkMandatoryBudget(req, res, detectedWire?.wire)` ngay sau `applyConversation` — trả về sớm nếu đã từ chối. Không đổi thứ tự các bước khác
- [ ] T024 [US1] Triển khai `server/src/custom/context-budget/hooks.ts`: `contextRoutingTokens(req, routingTotal, messages)` và `fitContextForRoute(req, res, messages, route, outputReserve)` theo research.md R2/R3 và T016 — lấy `base`/`lastOutput` từ registry, `classifySegments` → `fitToBudget` với `route.contextWindow`, `fallbackWindowTokens` của mặc định hệ thống; phần dành cho câu trả lời = `outputReserve` khi `registry.clientMaxTokens` khác null, ngược lại `policy.outputReserveTokens`; khi `ok: false` ném lỗi `Object.assign(new Error('Required context exceeds this model\'s context window'), { providerRejection: 'request' })`; khi khớp thành công lưu `windowStartMessageId` và đặt `registry.fitted = true`
- [ ] T025 [US1] Trong `hooks.ts`, sau khi khớp và khi `!res.headersSent`: đặt `X-Conversation-History` = số tin lịch sử phía server thực sự gửi (chỉ khi chính sách bật và request có `X-Conversation-Id`)
- [ ] T026 [US1] Móc upstream `server/src/routes/proxy.ts` (đúng 2 dòng, thêm 1 import): trong closure `route` của `runFallbackLoop` ở handler chat completions, đổi đối số đầu của `routeRequest(` từ `routingEstimate` thành `contextRoutingTokens(req, routingEstimate, messages)`; trong `dispatch`, ngay sau khối khôi phục reasoning (`restoreSessionReasoning`), thêm `outboundMessages = fitContextForRoute(req, res, outboundMessages, route, outputReserve);`
- [ ] T027 [P] [US1] Móc upstream `server/src/routes/anthropic.ts` (2 dòng + 1 import): trong closure `route` của `handleMessages`, bọc `routingTotal` bằng `contextRoutingTokens(req, routingTotal, messages)`; dòng đầu của `dispatch`: `messages = fitContextForRoute(req, res, messages, route, outputReserve);`
- [ ] T028 [P] [US1] Móc upstream `server/src/routes/responses.ts` (2 dòng + 1 import): như T027 trong `handleResponses`
- [ ] T029 [P] [US1] Móc upstream `server/src/lib/inbound-chat.ts` (2 dòng + 1 import): bọc `routingTotal` trong closure `route`; dòng đầu của `dispatch`: `input.messages = fitContextForRoute(req, res, input.messages, route, outputReserve);`
- [ ] T030 [US1] Chạy T016–T019 tới khi đạt; chạy `npm run test -w server` và `npm run lint -w server` để xác nhận không hỏng test hiện có của 4 surface

**Checkpoint**: US1 dùng được độc lập — MVP: request không bao giờ vượt ngân sách/cửa sổ, fallback sang model nhỏ được khớp lại, key tắt không đổi

---

## Phase 4: User Story 2 - Thấy được ngữ cảnh đã được lắp như thế nào (Priority: P1)

**Goal**: Header phân bổ trên mỗi phản hồi, báo cáo theo request, API chính sách/thống kê/xem trước, thẻ dashboard.

**Independent Test**: quickstart.md mục 9.

### Tests for User Story 2 ⚠️

- [ ] T031 [P] [US2] Viết `server/src/__tests__/custom/context-budget/report.test.ts`: `formatContextHeader()` đúng thứ tự và khóa trong contracts/context-metadata.md mục 1 (`window=unknown` khi null); báo cáo được ghi vào `custom_context_reports` với `request_id` = `trace.lastRequestRowId` sau sự kiện `finish`; không ghi khi không có trace hoặc chính sách tắt; không cột nào chứa nội dung tin nhắn; `pruneContextReports()` xóa báo cáo mồ côi (không còn dòng `requests`) và của key đã xóa, chạy tối đa 1 lần/giờ; khi `requests.input_tokens ≠ heuristic_tokens` thì `recordCalibrationSample` được gọi
- [ ] T032 [P] [US2] Viết `server/src/__tests__/routes/context-policy.test.ts` cho mọi endpoint trong contracts/context-policy-api.md: `GET/PUT/DELETE /api/client-profiles/:id/context-policy` (các mã lỗi 400 ở T007, 404 `profile_not_found`, `suggested` khác null khi kế thừa và key bật hội thoại); `GET …/context-stats?days=` (`days` ngoài [1, 90] → 400; `estimateError` chỉ tính dòng có usage thật); `GET …/conversations/:conv/context-preview` (404 `conversation_not_found`, 409 `context_policy_disabled`, `preview` ≤ 200 ký tự, `reason` thuộc tập cho phép, không gọi provider); `GET/PUT /api/settings/context-policy`; `GET …/requests/:requestId/context` (404 `context_report_not_found`); phân quyền: thành viên chỉ có `view_client_profiles` đọc được chính sách/thống kê nhưng bị 403 khi `PUT` và khi xem trước; `view_settings`/`edit_settings` cho mặc định hệ thống
- [ ] T033 [P] [US2] Viết `client/src/custom/ContextPolicyCard.test.tsx` (mẫu: `ConversationsCard.test.tsx`): hiển thị trạng thái kế thừa; chọn mức đặt sẵn điền đúng giá trị; chế độ Tùy chỉnh chặn tổng tỷ lệ > 80 và ngân sách < 2.000 trước khi gửi; hiển thị `suggested` để xác nhận khi bật lần đầu; thẻ thống kê hiển thị token trung bình, tỷ lệ thu gọn, token tiết kiệm, sai số ước lượng

### Implementation for User Story 2

- [ ] T034 [US2] Triển khai `server/src/custom/context-budget/report.ts`: `formatContextHeader(summary)`, `beginReport(req)`, `persistReportOnFinish(req, res)` (giữ `getRequestTrace()` lấy ở dispatch, trên `finish` dùng `setImmediate` đọc `lastRequestRowId` rồi `INSERT OR REPLACE` vào `custom_context_reports`; đọc `requests.input_tokens` của dòng đó, nếu khác `heuristic_tokens` thì gọi `recordCalibrationSample(platform, input_tokens, estimated_tokens)`), `pruneContextReports(now)` (mỗi giờ tối đa một lần, cũng gọi `pruneOrphanPolicies()`), `getReportForRequest(profileId, requestId)`
- [ ] T035 [US2] Nối báo cáo vào `server/src/custom/context-budget/hooks.ts`: sau mỗi lần khớp, cập nhật `registry.report` và đặt `X-FreeLLM-Context` khi `!res.headersSent`; lần khớp đầu tiên đăng ký `persistReportOnFinish` một lần; gọi `pruneContextReports` không chặn
- [ ] T036 [P] [US2] Triển khai `server/src/custom/context-budget/stats.ts`: `getContextStats(profileId, days)` trả `ContextStats` từ `custom_context_reports` join `requests` theo `profile_id` và `created_at`; `savedTokens` = tổng token các phần đã bỏ; `estimateError` chỉ tính dòng `requests.input_tokens ≠ heuristic_tokens`, gồm p50, p95 và `within15PctRate`
- [ ] T037 [P] [US2] Triển khai `server/src/custom/context-budget/preview.ts`: `previewConversationContext(profileId, conversationKey, { modelKey?, endUser? })` dựng lại phần bắt buộc (prompt ép của key nếu có, qua `resolveAuth`/system prompt hiện có) + tóm tắt + lịch sử ứng viên, giả lập tin người dùng rỗng, chọn cửa sổ theo `modelKey` hoặc lớn nhất trong model key được phép (dùng `servableContextWindow` của `services/model-listing.ts`), chạy `classifySegments` + `fitToBudget`, trả `ContextPreview` theo contracts/context-policy-api.md mục 3; không gọi provider, không ghi DB
- [ ] T038 [US2] Triển khai `server/src/routes/context-policy.ts`: `contextPolicyRouter` gồm các route trong contracts/context-policy-api.md mục 1–3 và `…/requests/:requestId/context` (contracts/context-metadata.md mục 4); `contextPolicySettingsRouter` cho `GET/PUT /api/settings/context-policy`. Validate bằng zod, mã lỗi đúng contract
- [ ] T039 [US2] Gắn router trong `server/src/custom/register.ts`: thêm `contextPolicyRouter` vào danh sách `app.use('/api/client-profiles', …)` và mount `contextPolicySettingsRouter` cùng chỗ với các route `/api/settings` custom khác
- [ ] T040 [US2] Sửa `server/src/custom/permission-actions.ts`: mở rộng regex đọc nội dung thành `/^\/api\/client-profiles\/\d+\/(?:conversations\/[^/]+(?:\/context-preview)?|content-filter\/events|feedback\/comments)$/` để xem trước cần `edit_client_profiles`; thêm `'context-policy'` vào danh sách tên `/api/settings/${name}`
- [ ] T041 [P] [US2] Tạo `client/src/custom/ContextPolicyCard.tsx`: bật/tắt, chọn mức đặt sẵn, các trường Tùy chỉnh với giới hạn từ `CONTEXT_POLICY_LIMITS`, chế độ lịch sử do client gửi, xác nhận giá trị `suggested`, khối thống kê 7 ngày từ `/context-stats`; dùng TanStack Query và `apiFetch` như `ConversationsCard.tsx`; chuỗi qua `tc()`
- [ ] T042 [P] [US2] Tạo `client/src/custom/ContextPreviewDialog.tsx`: gọi `/context-preview`, hiển thị bảng phần (loại, vai trò, token, đã gửi/bỏ, lý do) và tổng ngân sách; thêm nút "Xem trước ngữ cảnh" cho từng hội thoại trong `client/src/custom/ConversationsCard.tsx` (chỉ hiện khi chính sách bật)
- [ ] T043 [US2] Thêm `ContextPolicyCard` vào `client/src/custom/ProfileUsagePage.tsx`, ngay sau `ConversationsCard`
- [ ] T044 [P] [US2] Hiển thị báo cáo lắp ráp trong phần mở rộng của một dòng request ở `client/src/custom/RecentRequestsCard.tsx` (gọi `…/requests/:requestId/context`, ẩn khi 404)
- [ ] T045 [US2] Thêm mọi chuỗi giao diện mới vào `client/src/custom/i18n/vi.ts`; chạy `client/src/custom/i18n/translations.test.ts`

**Checkpoint**: US1 + US2 hoạt động; quản trị viên thấy và chỉnh được ngân sách

---

## Phase 5: User Story 3 - Tóm tắt kích hoạt theo áp lực ngân sách (Priority: P2)

**Goal**: Lượt rơi khỏi cửa sổ thực tế được gộp vào tóm tắt đúng một lần; tóm tắt nằm trong trần của nó.

**Independent Test**: quickstart.md mục 6 (≥ 18/20 sự kiện được nhớ).

### Tests for User Story 3 ⚠️

- [ ] T046 [P] [US3] Viết `server/src/__tests__/custom/context-budget/summary.test.ts`: sau lượt thành công với chính sách bật, `custom_conversations.context_window_start_id` = id tin lịch sử cũ nhất đã gửi; `foldableTurns` trả các tin có `summarized_through < id < context_window_start_id` (tối đa 16.000 ký tự), trả null khi không có; mỗi tin chỉ được gộp một lần qua hai lượt tóm tắt liên tiếp; lời gọi tóm tắt thất bại → lượt sau vẫn dùng tóm tắt cũ + cửa sổ trượt và lần sau gộp lại; tóm tắt của end user A không bao giờ xuất hiện trong ngữ cảnh của end user B cùng key; `summaryPrompt` dùng số từ mục tiêu = clamp(round(trần × 0,6), 80, 400) và `max_tokens` = trần tóm tắt; chính sách tắt → hành vi `foldableTurns` cũ không đổi; request đi đường ngoài phạm vi (câu trả lời nhanh có `X-Conversation-Id`, MCP takeover) với chính sách bật → không ghi `context_window_start_id`, không header `X-FreeLLM-Context`, tóm tắt dùng cách tính cũ; dòng `requests` của lời gọi tóm tắt có `client_user_agent = 'freellm-conversation-summary'` (FR-021)

### Implementation for User Story 3

- [ ] T047 [US3] Trong `server/src/services/profile-conversations.ts`: thêm `saveWindowStart(conversationId, messageId)` và tham số tùy chọn `boundaryId` cho `foldableTurns(conversationId, s, boundaryId?)` — khi có thì dùng ranh giới đó thay cho phép tính theo `maxMessages`/`maxChars`; không đổi kết quả khi không truyền
- [ ] T048 [US3] Sửa `server/src/custom/conversation-inject.ts`: trong callback `captureReply`, chỉ khi registry tồn tại **và** `registry.fitted === true` thì gọi `saveWindowStart(id, registry.windowStartMessageId)` trước `scheduleSummary` (ngược lại giữ nguyên hành vi cũ), và truyền ranh giới + trần tóm tắt vào `scheduleSummary` (bỏ qua khi `policy.summarize = false`)
- [ ] T049 [US3] Sửa `server/src/custom/conversation-summary.ts`: `scheduleSummary`/`summarizeConversation` nhận `{ boundaryId?, summaryCapTokens? }`; `summaryPrompt(previous, turns, targetWords = 200)` dùng `targetWords`; `max_tokens` = `summaryCapTokens ?? 500`; giữ nguyên cơ chế `inFlight`, loopback, user-agent `freellm-conversation-summary`
- [ ] T050 [US3] Hiển thị "tóm tắt tới tin" và số tin đang chờ gộp (`summary.coversThroughMessageId`, `pendingFoldMessages`) trong `client/src/custom/ContextPreviewDialog.tsx`; thêm chuỗi vào `client/src/custom/i18n/vi.ts`

**Checkpoint**: US3 hoạt động độc lập trên nền US1

---

## Phase 6: User Story 4 - Tri thức truy hồi được chia ngân sách cùng lịch sử (Priority: P2)

**Goal**: Tri thức nằm trong trần riêng, đủ liên quan, không trùng lịch sử; phần dư nhường lịch sử; trích dẫn chỉ gồm đoạn đã gửi.

**Independent Test**: quickstart.md mục 7.

### Tests for User Story 4 ⚠️

- [ ] T051 [P] [US4] Viết `server/src/__tests__/custom/context-budget/knowledge.test.ts`: với chính sách bật, trần tri thức = `knowledgeSharePct% × (provisionalBudget − mandatoryTokens)` (research.md R7); ứng viên được lấy với `maxChars` = trần × 4 rồi giữ từng đoạn theo điểm giảm dần khi tổng `estimateTextTokens` ≤ trần; với câu hỏi tiếng Anh và đoạn tri thức tiếng Việt, tổng token tri thức đã chèn vẫn ≤ trần; các đoạn được giữ nguyên vẹn, mỗi đoạn được đăng ký; câu hỏi không khớp → không chèn, `kb_sent=0` và lịch sử nhận phần dư; đoạn có ≥ 80% shingle 5 từ đã có trong lịch sử ứng viên hoặc tóm tắt bị bỏ; `knowledgeMinScore` loại đoạn ngữ nghĩa dưới ngưỡng; khi giai đoạn dispatch bỏ khối tri thức thì header `x-freellm-citations` bị gỡ (khi header chưa gửi) và phần trích dẫn trong thân phản hồi không còn; chính sách tắt → `maxChars` cũ không đổi

### Implementation for User Story 4

- [ ] T052 [US4] Sửa `server/src/custom/knowledge-inject.ts`: khi registry tồn tại, tính trần tri thức bằng token theo research.md R7/R10, lấy ứng viên với `maxChars` = trần × 4 rồi chọn từng đoạn theo `estimateTextTokens` (không cắt giữa đoạn), lọc trùng bằng shingle 5 từ so với các đơn vị `history`/`summary` đã đăng ký, áp `knowledgeMinScore` cho kết quả ngữ nghĩa, đăng ký từng đoạn được chèn (`registerUnit` kind `knowledge`)
- [ ] T053 [US4] Sửa `server/src/custom/ai-platform/pipeline.ts` (slot 6): khi registry tồn tại, truyền `maxChars` = trần tri thức × 4 vào `injectRetrievedKnowledgeForSlot6` thay cho `_profile.knowledge?.maxChars`, rồi lọc từng đoạn theo token như T052 (dùng chung một hàm `selectPassagesWithinTokens` trong `server/src/custom/context-budget/gate.ts`); không đổi gì khi tắt
- [ ] T054 [US4] Trong `server/src/custom/context-budget/hooks.ts`: khi `fitToBudget` trả `knowledgeDropped`, gỡ header `x-freellm-citations` nếu `!res.headersSent` và đặt cờ trên registry; sửa `server/src/custom/ai-platform/retrieval/citations.ts` để bộ lọc citations bỏ qua phần trích dẫn khi cờ đó được đặt

**Checkpoint**: US4 hoạt động độc lập trên nền US1

---

## Phase 7: User Story 5 - Bảo vệ ngân sách cho ứng dụng tự gửi toàn bộ lịch sử (Priority: P3)

**Goal**: Ba chế độ cho lịch sử do client gửi; mặc định giữ nguyên.

**Independent Test**: quickstart.md mục 8.

### Tests for User Story 5 ⚠️

- [ ] T055 [P] [US5] Viết `server/src/__tests__/custom/context-budget/client-history.test.ts` qua `/v1/chat/completions`, `/v1/messages`, `/v1/responses` và Gemini `:generateContent` với 200 tin do client gửi (không `X-Conversation-Id`): `passthrough` → thân gửi đi giống hệt client gửi, `client_dropped=0`, model nhỏ vẫn bị router loại như trước; `trim_on_overflow` → khi lịch sử vượt cửa sổ của mọi model, tin cũ nhất bị bỏ cho tới khi vừa thay vì lỗi "không có model phù hợp", trần key bị bỏ qua; `enforce_budget` → tổng ≤ ngân sách hiệu lực; mọi chế độ: tin system, tin người dùng cuối và chuỗi công cụ đang dở không bị bỏ, cặp tool call/kết quả không bị tách, không tạo hay lưu tóm tắt, header ghi đúng `client_dropped`; với hai model giả (8.192 và 131.072, model lớn trả 503) ở chế độ `enforce_budget`, cả 4 surface khớp lại thành công qua model nhỏ và header có `refits=1` (phần còn lại của FR-010)

### Implementation for User Story 5

- [ ] T056 [US5] Hoàn thiện nhánh `client_history` trong `server/src/custom/context-budget/hooks.ts` và `fit.ts` theo research.md R11: chọn công thức ngân sách theo chế độ; `contextRoutingTokens` trừ phần `client_history` có thể bỏ khi chế độ ≠ `passthrough`; đảm bảo `prepareContextBudget` vẫn tạo registry cho request không có `X-Conversation-Id` khi chính sách bật
- [ ] T057 [US5] Trong `client/src/custom/ContextPolicyCard.tsx`, thêm giải thích cho ba chế độ lịch sử do client gửi (đặc biệt: chế độ thu gọn thay đổi nội dung client gửi) và chuỗi tương ứng trong `client/src/custom/i18n/vi.ts`

**Checkpoint**: Mọi user story hoạt động độc lập

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Hiệu chỉnh, hiệu năng, công cụ nghiệm thu, tài liệu

- [ ] T058 [P] Viết `scripts/context-budget-replay.mjs` (Node ≥ 20, không phụ thuộc mới) với các tùy chọn trong quickstart.md: `--key`, `--base-url` (mặc định `http://localhost:3001`), `--turns`, `--conversation`, `--scenario fact-recall`, `--client-history <n>`, `--mock`; in bảng token theo lượt từ header `X-FreeLLM-Context`, kiểm tra dao động ±10% từ lượt 50 (SC-002), tính tỷ lệ tiết kiệm = 1 − (token đã gửi từ lượt 51) / (token nếu gửi toàn bộ lịch sử từ lượt 51) và báo đạt khi ≥ 60% (SC-003), và đếm câu đúng của kịch bản nhớ sự kiện (SC-004); không in key ra màn hình
- [ ] T059 [P] Viết `server/src/__tests__/custom/context-budget/perf.test.ts`: `classifySegments` + `fitToBudget` trên hội thoại 1.000 tin chạy 200 lần, p95 ≤ 50 ms (SC-007)
- [ ] T060 Hiệu chỉnh hằng số trong `server/src/custom/context-budget/estimate.ts`: chạy `scripts/context-budget-replay.mjs` với hội thoại Anh/Việt/Trung trên ít nhất 2 nhà cung cấp, so `estimateError` trong `/context-stats`; điều chỉnh hệ số nhóm ký tự tới khi `within15PctRate ≥ 0,95` (SC-005); ghi số liệu và model đã dùng vào `specs/021-context-engineering/acceptance.md`
- [ ] T061 [P] Viết tài liệu vận hành `docs/context-budget.md`: chính sách là gì, ba mức đặt sẵn, cách đọc header `X-FreeLLM-Context`, xem trước, thống kê, ba chế độ lịch sử do client gửi, giới hạn đã biết (ước lượng gần đúng; báo cáo theo lượt cuối trước khi gửi header). Dùng ngôn ngữ kỹ thuật trung tính (AGENTS.md mục 6 Rule 3)
- [ ] T062 [P] Cập nhật `specs/README.md`: chuyển 021 sang trạng thái đang triển khai/đã xong kèm bằng chứng, cập nhật dòng `**Status**` trong `specs/021-context-engineering/spec.md`
- [ ] T063 Chạy `npm run test`, `npm run test:migrations`, `npm run lint`, `npm run build`; sửa mọi lỗi
- [ ] T064 Chạy đủ quickstart.md mục 1–10 và ghi kết quả từng mục (đạt/không đạt/không chạy được, lý do) vào `specs/021-context-engineering/acceptance.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: không phụ thuộc
- **Foundational (Phase 2)**: sau Setup — chặn mọi user story
- **US1 (Phase 3)**: sau Foundational — MVP
- **US2 (Phase 4)**: sau US1 (báo cáo dựa trên kết quả khớp của `hooks.ts`)
- **US3, US4, US5 (Phase 5–7)**: sau US1; độc lập với nhau và với US2 (trừ T050 và T057 cần các file UI của US2)
- **Polish (Phase 8)**: sau các story muốn đưa vào bản phát hành; T060 cần US2 (thống kê sai số)

### User Story Dependencies

```text
Setup → Foundational → US1 ─┬─► US2 ──► (T050, T057 UI)
                            ├─► US3
                            ├─► US4
                            └─► US5
                                   └─► Polish
```

### Within Each User Story

- Test viết trước và phải thất bại trước khi triển khai
- Service/thuật toán trước, móc và route sau, UI cuối
- Mỗi story xong thì chạy lại toàn bộ test server

### File dùng chung (tránh sửa song song)

- `server/src/custom/context-budget/hooks.ts`: T024, T025 (US1) → T035 (US2) → T054 (US4) → T056 (US5)
- `server/src/custom/conversation-inject.ts`: T022 (US1) → T048 (US3)
- `server/src/services/profile-conversations.ts`: T020 (US1) → T047 (US3)
- `client/src/custom/i18n/vi.ts`: T045 → T050 → T057
- `client/src/custom/ContextPreviewDialog.tsx`: T042 → T050

### Parallel Opportunities

- Phase 1: T002, T003
- Phase 2: T006, T007, T009, T011, T012, T014 song song; sau đó T008, T010, T013, T015 theo cặp test tương ứng
- US1: T016–T019 song song; T027, T028, T029 song song (khác file) sau T024
- US2: T031–T033 song song; T036, T037, T041, T042, T044 song song
- Sau US1: US3, US4, US5 có thể giao cho ba người/agent khác nhau (mỗi người một nhánh riêng theo AGENTS.md mục 5), lưu ý thứ tự sửa `hooks.ts` ở trên

---

## Parallel Example: User Story 1

```bash
# Viết test US1 cùng lúc:
Task: "T016 hooks.test.ts"
Task: "T017 gate.test.ts"
Task: "T018 regression.test.ts"
Task: "T019 surfaces.test.ts"

# Sau khi T024 (hooks.ts) xong, móc 3 surface còn lại song song:
Task: "T027 móc routes/anthropic.ts"
Task: "T028 móc routes/responses.ts"
Task: "T029 móc lib/inbound-chat.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup → Phase 2 Foundational (`fitToBudget` test kỹ)
2. Phase 3 US1 → **dừng và kiểm chứng**: quickstart.md mục 2–5, hồi quy SC-006
3. Có thể phát hành MVP (header phân bổ chưa có, nhưng request đã nằm trong ngân sách)

### Incremental Delivery

1. Setup + Foundational → nền sẵn sàng
2. US1 → kiểm chứng → phát hành (MVP)
3. US2 → quản trị viên thấy và chỉnh được → phát hành
4. US3, US4 → chất lượng trả lời trong hội thoại dài → phát hành
5. US5 → mở rộng cho ứng dụng không dùng hội thoại phía server
6. Polish → hiệu chỉnh ước lượng, nghiệm thu

### Parallel Team Strategy

1. Một người làm Setup + Foundational + US1 (chạm file upstream, nên một người giữ)
2. Sau US1: A làm US2, B làm US3, C làm US4; US5 sau cùng vì chạm lại `hooks.ts`/`fit.ts`
3. Mỗi người một nhánh và một PR riêng nhắm `main`, CI xanh trước khi merge (AGENTS.md mục 5)

---

## Notes

- [P] tasks = khác file, không phụ thuộc task chưa xong
- [Story] label gắn task với user story để truy vết
- Commit sau mỗi task hoặc nhóm logic; dừng ở mỗi checkpoint để kiểm chứng story độc lập
- Tránh: task mơ hồ, sửa cùng file song song, phụ thuộc chéo giữa story làm mất tính độc lập
