# Implementation Plan: Lắp ráp ngữ cảnh có ngân sách token (Context Engineering)

**Branch**: `claude/beautiful-goldberg-6uxvyu` | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/021-context-engineering/spec.md`

## Summary

Gateway đã có kho hội thoại, cửa sổ trượt, tóm tắt cuốn chiếu và truy hồi tri thức, nhưng mỗi phần tự giới hạn bằng ký tự và không biết model đích. Kế hoạch thêm **bộ quản lý ngân sách token** và một thứ tự lắp ráp thống nhất, chạy theo hai giai đoạn:

1. **Thu thập ở gate** (code custom hiện có): khi chính sách của key bật, chèn ứng viên lịch sử, tóm tắt, tri thức như hôm nay nhưng với trần rộng hơn, và ghi từng đơn vị vào sổ đăng ký phân đoạn gắn với request.
2. **Khớp ngân sách ở dispatch**: ngay trước khi gửi tới model đã chọn, bỏ dần lịch sử (theo khối neo cố định để giữ cache prompt), rồi tri thức, rồi tóm tắt, cho tới khi vừa `min(ngân sách key, cửa sổ model − phần câu trả lời) × (1 − biên an toàn)`. Mỗi lượt fallback khớp lại từ bản gốc.

Đi kèm: bộ ước lượng token theo nhóm chữ viết có hiệu chỉnh từ usage thật, tóm tắt kích hoạt theo ranh giới cửa sổ thực tế, chế độ tùy chọn cho lịch sử do client gửi, header `X-FreeLLM-Context`, bảng báo cáo theo request, API chính sách/xem trước/thống kê và thẻ dashboard. Mọi thứ mặc định tắt. File upstream chỉ nhận 8 dòng móc (2 dòng × 4 surface). Chi tiết quyết định: [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript (ESM), Node.js ≥ 20.18 < 25

**Primary Dependencies**: Express, zod (server); React + Vite + TanStack Query + Tailwind + Lucide (client). Không thêm phụ thuộc mới; không dùng thư viện tokenizer (research R4)

**Storage**: SQLite (better-sqlite3, WAL) hoặc Turso/libSQL qua lớp `getDb()` hiện có; 2 bảng mới, 1 cột mới trên bảng custom, 1 khóa `settings` (data-model)

**Testing**: Vitest (server, client); bộ roundtrip migration (`npm run test:migrations`); script phát lại `scripts/context-budget-replay.mjs` cho nghiệm thu thủ công với model thật

**Target Platform**: Linux server / Docker non-root; cũng chạy single-user cục bộ và desktop

**Project Type**: Web service (monorepo `shared`, `server`, `client`)

**Performance Goals**: Khớp ngân sách ≤ 50 ms p95 với hội thoại 1.000 tin (SC-007); chính sách tắt: chi phí thêm ≈ 0 (một tra cứu bộ đệm theo `profile_id`)

**Constraints**: Không đổi request gửi đi khi chính sách tắt (SC-006); không bao giờ gửi request vượt cửa sổ model đã biết; không lưu nội dung tin nhắn vào báo cáo; lời gọi tóm tắt vẫn chạy nền, không chặn phản hồi

**Scale/Scope**: Hàng trăm client key, hội thoại tới vài nghìn tin, kho tri thức tới 200 tài liệu mỗi key (giới hạn hiện có)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Nguyên tắc | Đánh giá | Kết quả |
|---|---|---|
| I. Bảo mật & bảo vệ credential | Lời gọi tóm tắt tiếp tục dùng cơ chế loopback có giải mã key hiện có; không log key; báo cáo và header không chứa nội dung | ĐẠT |
| II. Monorepo & tách lớp | Kiểu dùng chung ở `shared/context-budget.ts`; logic ở `server/`; UI ở `client/` | ĐẠT |
| III. Bền vững trước upstream | Lỗi khớp ngân sách dùng nhánh `providerRejection` sẵn có của fallback loop, không cooldown, không "học" sai cửa sổ (R3); migration idempotent, đảo ngược được | ĐẠT |
| IV. Test-first | Mỗi user story có test đơn vị/tích hợp viết trước; roundtrip migration; hồi quy byte-for-byte khi tắt | ĐẠT |
| V. Tương thích ngược | Mặc định tắt; lịch sử do client gửi mặc định chuyển nguyên văn; `/v1/*`, `/livez`, `/readyz`, `/api/ping` không đổi | ĐẠT |
| VI. Zero-conflict | File mới cho service/route/component/migration. Điểm móc vào file upstream: 8 dòng (xem Complexity Tracking). File custom được sửa: `profile-gate.ts`, `conversation-inject.ts`, `conversation-summary.ts`, `knowledge-inject.ts`, `ai-platform/pipeline.ts`, `profile-conversations.ts`, `permission-actions.ts`, `register.ts`, `ProfileUsagePage.tsx`, `ConversationsCard.tsx`, `i18n/vi.ts`, `migrate/defaults.ts` | ĐẠT (có ghi chú) |
| VII. Nhánh & PR | Làm trên nhánh riêng, qua PR, chờ CI xanh | ĐẠT |

**Đánh giá lại sau Phase 1**: thiết kế trong data-model và contracts không thêm vi phạm nào. Bảng mới thay vì thêm cột vào `client_profiles`/`requests`; không trigger mới (tránh khai báo thêm cho bộ đệm đọc Turso). ĐẠT.

## Project Structure

### Documentation (this feature)

```text
specs/021-context-engineering/
├── spec.md
├── plan.md              # File này
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── context-policy-api.md
│   └── context-metadata.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
shared/
└── context-budget.ts                         # MỚI: kiểu, mức đặt sẵn, giới hạn

server/src/
├── custom/context-budget/                    # MỚI: toàn bộ logic của tính năng
│   ├── policy.ts                             # đọc/ghi chính sách, mặc định hệ thống, bộ đệm, mức đặt sẵn
│   ├── estimate.ts                           # bộ ước lượng token + hiệu chỉnh theo nền tảng (R4)
│   ├── registry.ts                           # sổ đăng ký phân đoạn theo request (R5)
│   ├── segments.ts                           # phân loại ChatMessage[] thành segment, nhóm tool call (R6)
│   ├── fit.ts                                # thuật toán khớp ngân sách thuần, không I/O (R6, R7)
│   ├── hooks.ts                              # contextRoutingTokens(), fitContextForRoute() — 2 điểm móc
│   ├── gate.ts                               # thu thập ở gate: lịch sử ứng viên, chống trùng tri thức, lỗi context_budget_exceeded
│   ├── report.ts                             # header X-FreeLLM-Context, ghi custom_context_reports, dọn dẹp
│   ├── stats.ts                              # thống kê theo key (FR-032)
│   └── preview.ts                            # xem trước ngữ cảnh (FR-031)
├── routes/context-policy.ts                  # MỚI: API chính sách, thống kê, xem trước, mặc định hệ thống, báo cáo theo request
├── db/migrations/20261117_100000_custom_context_budget.ts   # MỚI
├── db/migrate/defaults.ts                    # +1 dòng đăng ký migration
├── services/profile-conversations.ts         # SỬA (custom): loadHistoryCandidates(), foldableTurns theo ranh giới, saveWindowStart()
├── custom/conversation-inject.ts             # SỬA (custom): nhánh chính sách bật → ứng viên + đăng ký phân đoạn; lưu ranh giới khi xong lượt
├── custom/conversation-summary.ts            # SỬA (custom): độ dài mục tiêu theo trần tóm tắt
├── custom/knowledge-inject.ts                # SỬA (custom): maxChars theo trần tri thức, đăng ký đoạn, chống trùng
├── custom/ai-platform/pipeline.ts            # SỬA (custom): truyền trần tri thức cho slot 6 khi chính sách bật
├── middleware/profile-gate.ts                # SỬA (custom): gọi prepareContextBudget() một lần trước applyConversation
├── custom/permission-actions.ts              # SỬA (custom): quyền xem trước + 'context-policy' trong cài đặt
├── custom/register.ts                        # SỬA (custom): gắn contextPolicyRouter
├── routes/proxy.ts                           # MÓC upstream: 2 dòng (route + dispatch)
├── routes/anthropic.ts                       # MÓC upstream: 2 dòng
├── routes/responses.ts                       # MÓC upstream: 2 dòng
├── lib/inbound-chat.ts                       # MÓC upstream: 2 dòng
└── __tests__/
    ├── custom/context-budget/                # MỚI: estimate, fit, segments, hooks, gate, summary, knowledge, client-history, report, perf, regression
    │   └── fixtures/                         # hội thoại mẫu Anh/Việt/Trung, kịch bản nhớ sự kiện
    ├── routes/context-policy.test.ts         # MỚI
    └── db/migrate/context-budget.test.ts     # MỚI (+ cập nhật danh sách trong roundtrip.test.ts, turso-read-cache.test.ts)

client/src/custom/
├── ContextPolicyCard.tsx                     # MỚI: cấu hình chính sách + thống kê 7 ngày
├── ContextPolicyCard.test.tsx                # MỚI
├── ContextPreviewDialog.tsx                  # MỚI: xem trước ngữ cảnh của một hội thoại
├── ProfileUsagePage.tsx                      # SỬA (custom): thêm ContextPolicyCard
├── ConversationsCard.tsx                     # SỬA (custom): nút "Xem trước ngữ cảnh"
└── i18n/vi.ts                                # SỬA: chuỗi tiếng Việt

scripts/
└── context-budget-replay.mjs                 # MỚI: phát lại hội thoại cho nghiệm thu (quickstart)
```

**Structure Decision**: Monorepo web service hiện có. Toàn bộ logic mới gom trong `server/src/custom/context-budget/` (cùng kiểu `custom/ai-platform/`) để người đồng bộ upstream thấy ngay ranh giới. Hàm khớp ngân sách (`fit.ts`) là hàm thuần nhận `ChatMessage[]` + sổ đăng ký + ngân sách, nên test được độc lập với Express và provider.

## Luồng request khi chính sách bật

```text
profile-gate
  ├─ prepareContextBudget(req, profile)      → giải quyết chính sách, tạo registry (no-op nếu tắt)
  ├─ applyConversation()                     → ứng viên lịch sử + tóm tắt, đăng ký từng tin (chat/anthropic)
  ├─ injectKnowledge() / slot 6 retrieval    → đoạn tri thức trong trần, chống trùng, đăng ký
  └─ checkMandatoryBudget()                  → 400 context_budget_exceeded nếu phần bắt buộc > ngân sách key
surface (proxy | anthropic | responses | inbound-chat)
  ├─ nén, output savers, prompt ép, ước lượng   (không đổi)
  └─ runFallbackLoop
       ├─ route():    routeRequest(contextRoutingTokens(req, routingTotal, messages), …)   ← MÓC R
       └─ dispatch(): messages = fitContextForRoute(req, res, messages, route, outputReserve) ← MÓC B
                        → phân loại segment, khớp ngân sách, đặt header, giữ trace để ghi báo cáo
response finish
  ├─ conversation-inject: lưu lượt + context_window_start_id → scheduleSummary()
  └─ report: ghi custom_context_reports theo trace.lastRequestRowId; cập nhật hệ số hiệu chỉnh
```

## Thứ tự triển khai đề xuất (chi tiết trong tasks.md)

1. **Nền tảng**: kiểu dùng chung, migration, `policy.ts`, `estimate.ts`, `registry.ts`, `segments.ts`, `fit.ts` (thuần, test kỹ).
2. **US1** (MVP): `hooks.ts` + 8 dòng móc + nhánh gate cho hội thoại phía server + lỗi `context_budget_exceeded` + test hồi quy khi tắt.
3. **US2**: header, báo cáo, API chính sách/thống kê/xem trước, thẻ dashboard.
4. **US3**: ranh giới cửa sổ → gộp tóm tắt, độ dài theo trần.
5. **US4**: trần tri thức, chống trùng, bỏ cả khối, trích dẫn.
6. **US5**: chế độ lịch sử do client gửi.
7. **Hoàn thiện**: hiệu chỉnh hằng số ước lượng, script phát lại, đo hiệu năng, tài liệu vận hành (`docs/context-budget.md`), cập nhật `specs/README.md`.

US1 và US2 đều là P1; US2 phụ thuộc US1 (cần kết quả khớp để báo cáo). US3, US4, US5 độc lập với nhau sau US1.

## Rủi ro và cách giảm

| Rủi ro | Giảm thiểu |
|---|---|
| Ghép phân đoạn bằng dấu vân tay hỏng khi bộ nén viết lại nội dung | Tin không ghép được bị coi là do client gửi, chỉ bỏ khi chế độ cho phép; giai đoạn gate đã giới hạn ứng viên nên thường không cần bỏ thêm (R5) |
| Upstream đổi chữ ký `dispatch`/`route` khi đồng bộ | Móc chỉ là 1 lời gọi/1 phép gán mỗi chỗ; test tích hợp cho từng surface phát hiện ngay khi merge upstream |
| Ước lượng sai với ngôn ngữ mới | Hệ số hiệu chỉnh theo nền tảng + biên an toàn + thống kê sai số trên dashboard (SC-005) |
| Lời gọi tóm tắt tốn quota key miễn phí | Tóm tắt chỉ chạy khi có lượt rơi khỏi cửa sổ; một lần một hội thoại; có thể tắt theo key |
| Header thay đổi sau khi stream đã commit | Header chỉ phản ánh lượt cuối trước khi gửi header; báo cáo trong DB phản ánh lượt thực sự phục vụ |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| 8 dòng móc vào 4 file upstream (`routes/proxy.ts`, `routes/anthropic.ts`, `routes/responses.ts`, `lib/inbound-chat.ts`) | Ngân sách phụ thuộc model chỉ biết sau `routeRequest()`; FR-010 yêu cầu khớp lại ở từng lượt fallback | Lắp ở gate theo cửa sổ lớn nhất: model dự phòng nhỏ bị loại. Sửa `router.ts`/`fallback-loop.ts`: thay đổi lớn hơn ở file lõi upstream (research R1, R2) |
