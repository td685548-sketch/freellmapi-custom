# Handoff: Agent 2 — Foundation Wire Adapters & Response Interceptor (T002, T006–T011)

## Trạng thái tổng quan

- **T002** (`server/src/__tests__/helpers/ai-platform-fake-provider.ts`): **DONE** (commit riêng `2d8818d0c0796b22f0b7f7d7900d27554696ffc7`)
- **T006–T011** (`wire/{detect,extract,respond,interceptor}.ts` + tests): **DONE** (commit `1be8fdabdf083aab3e73c8f87a8f82698d2204bf`)
- **Tích hợp regression với T005 (Agent 3)**: **PARTIAL / CHƯA CHẠY** — `server/src/__tests__/custom/ai-platform/regression.test.ts` và baseline T005 của Agent 3 chưa được công bố trên nhánh phụ thuộc nên chưa thể chạy đối chiếu chéo.

## Git & Worktree

- **Base SHA**: `17328a176bd02b7510c51d7a458d038e16848a0b` (`origin/main`)
- **Branch**: `codex/ai-platform-foundation-wire`
- **Worktree**: `/tmp/wt-ai-platform-wire`
- **Prerequisite hashes**: Không có commit peer nào được nhập trước (nhánh Agent 1 và Agent 3 đều đang ở `17328a176bd02b7510c51d7a458d038e16848a0b`).
- **Commits tự viết**:
  1. `2d8818d0c0796b22f0b7f7d7900d27554696ffc7` — `test(ai-platform): add in-process 4-protocol fake provider helper (T002)`
  2. `1be8fdabdf083aab3e73c8f87a8f82698d2204bf` — `feat(ai-platform): add 4-protocol wire adapters and response interceptor (T006-T011)`

## Danh sách file & Exports đã giao

| File | Exports chính | Ghi chú |
|---|---|---|
| `server/src/__tests__/helpers/ai-platform-fake-provider.ts` | `startFakeProviderServer`, `detectFakeProviderWire`, `FakeProviderServer`, `FakeProviderWire`, `FakeProviderReply`, `FakeProviderRecordedRequest` | HTTP server cục bộ `127.0.0.1:0` (chỉ trong test), ghi `rawBody` (Buffer), `headers`, `aborted`; hỗ trợ 4 giao thức non-stream + SSE (+ Gemini JSON array stream), usage, tool calls, error, mid-stream drop, hang. |
| `server/src/custom/ai-platform/wire/detect.ts` | `Wire`, `detectWire(req)` | Nhận diện `POST /v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1beta/models/:model:generateContent` & `:streamGenerateContent`. Bỏ qua `/thruline/v1` và non-POST. |
| `server/src/custom/ai-platform/wire/extract.ts` | `ToolDefinition`, `lastUserText`, `requestedModel`, `setRequestedModel`, `addSystemBlock`, `addTools` | `ToolDefinition = ChatToolDefinition` từ `shared/types.ts`. `addSystemBlock` đặt `stable` trước `volatile` qua `WeakSet` (không thêm field lạ vào `req.body`). `setRequestedModel` giữ nguyên action & query string của Gemini URL. `addTools` dùng `sanitizeForGemini` cho Gemini. |
| `server/src/custom/ai-platform/wire/respond.ts` | `Usage`, `sendText(res, wire, stream, text, meta)` | `Usage = TokenUsage` từ `shared/types.ts`. Phát non-stream & SSE cho cả 4 giao thức với `finish: 'stop' | 'content_filter'` (`content_filter` / `refusal` / `incomplete` / `SAFETY`). |
| `server/src/custom/ai-platform/wire/interceptor.ts` | `OutputFilter`, `installInterceptor(req, res, wire, filters)` | `filters = []` trả ngay không chạm `res.write`/`res.end`/`res.json` hay headers. Bổ sung `failClosed?: boolean` trên `OutputFilter`. Xử lý tách UTF-8 (`StringDecoder`), SSE CRLF, nhiều event/chunk, `onDelta`, `buffering` + async `onComplete` (hủy khi `res` đóng, không dùng `req.close` đơn lẻ), `onUsage`, giới hạn bộ đệm `4 MiB`, finish tối đa 1 lần. |
| `server/src/__tests__/custom/ai-platform/wire-extract.test.ts` | 7 unit tests | T006 |
| `server/src/__tests__/custom/ai-platform/wire-respond.test.ts` | 2 unit tests | T008 |
| `server/src/__tests__/custom/ai-platform/wire-interceptor.test.ts` | 6 unit tests | T010 |

## Bằng chứng RED → GREEN & Lệnh kiểm tra

### RED (trước khi cài 4 file `wire/*.ts`)
- Lệnh: `npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/ai-platform/wire-extract.test.ts src/__tests__/custom/ai-platform/wire-respond.test.ts src/__tests__/custom/ai-platform/wire-interceptor.test.ts`
- Kết quả: **3 failed suites** — `Cannot find module '../../../custom/ai-platform/wire/{detect,interceptor,respond}.js'`.

### GREEN (sau khi cài `wire/*.ts`)
- `cd /tmp/wt-ai-platform-wire/server && npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/ai-platform/wire-extract.test.ts src/__tests__/custom/ai-platform/wire-respond.test.ts src/__tests__/custom/ai-platform/wire-interceptor.test.ts`
  - **3 passed files, 15 passed tests, 0 failed, 0 skipped** (`wire-extract.test.ts`: 7/7, `wire-interceptor.test.ts`: 6/6, `wire-respond.test.ts`: 2/2).
- `cd /tmp/wt-ai-platform-wire && npm run build -w server` → exit code `0`.
- `cd /tmp/wt-ai-platform-wire && npm run lint -w server` → exit code `0`.
- `cd /tmp/wt-ai-platform-wire && git diff --check` → exit code `0`.

## Ghi chú cho Reviewer & Agent 3

1. **Agent 3 (Baseline T005)**: Có thể lấy trực tiếp commit `2d8818d0c0796b22f0b7f7d7900d27554696ffc7` để dùng `ai-platform-fake-provider.ts` chụp baseline gốc trên base `17328a17` mà không kéo theo các file `wire/*.ts`.
2. **Mở rộng chữ ký đã thỏa thuận**: `OutputFilter` trong `wire/interceptor.ts` có thêm trường tùy chọn `failClosed?: boolean` đúng theo hợp đồng đợt Foundation.
3. **Giới hạn hiện tại của `wire/interceptor.ts`**:
   - Lớp `wire` chỉ cung cấp primitive buffering (`buffering: true` + `onComplete`, `onDelta`), chưa cài policy/detector của US3.
   - Gemini stream qua interceptor giả định định dạng SSE (`data: ...`); JSON array stream (`[...]` không có `?alt=sse`) sẽ rơi vào nhánh fail-open/pass-through nguyên vẹn nếu không có `data:` frames.
   - Chưa chạy `regression.test.ts` (do Agent 3 phụ trách sau T005 và nối `profile-gate.ts`).
