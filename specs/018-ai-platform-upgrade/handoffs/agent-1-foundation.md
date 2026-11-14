# Handoff: Agent 1 — Shared Contracts, Storage, Flags, Permissions & Audit (T001, T015, T017, T018, T022–T026, T028, T030)

## Trạng thái tổng quan

- **T001** (`shared/ai-platform.ts`, `shared/permissions.ts`): **DONE** (commit riêng `226c10ab5be44ffc506df396351e92613820474e`)
- **T015, T017, T018, T022–T026, T028, T030**: **DONE** (commit `305849fdaa09738c1e43cb7749b2507f01ab4658`)
- **Kiểm tra chéo T019 (`permissions.test.ts`), T020 (`audit.test.ts`), T033 (`regression.test.ts`)**: **PARTIAL / CHƯA CHẠY** — các file test của Agent 4 (`permissions.test.ts`, `audit.test.ts`) và Agent 3 (`regression.test.ts`) chưa được công bố trên nhánh phụ thuộc nên chưa chạy tích hợp toàn đợt.

## Git & Worktree

- **Base SHA**: `17328a176bd02b7510c51d7a458d038e16848a0b` (`origin/main`)
- **Branch**: `codex/ai-platform-foundation-core`
- **Worktree**: `/tmp/wt-ai-platform-core`
- **Prerequisite hashes**: Không có (các nhánh peer đang ở `17328a176bd02b7510c51d7a458d038e16848a0b`).
- **Commits tự viết**:
  1. `226c10ab5be44ffc506df396351e92613820474e` — `feat(ai-platform): add shared contracts, limits, and 21 permissions (T001)`
  2. `305849fdaa09738c1e43cb7749b2507f01ab4658` — `feat(ai-platform): add foundation flags, permissions, audit, masking, scope, and base migration (T015-T030)`

## Danh sách file & Exports đã giao

### CREATE
- `shared/ai-platform.ts`: `Pillar`, `PILLARS`, `PillarFlags`, `DEFAULT_PILLAR_FLAGS`, `ScopeKind`, `Scope`, `Wire`, `AI_PLATFORM_PARENT_PERMISSION`, `AI_PLATFORM_CHILD_PERMISSIONS` (21 quyền con), `AiPlatformChildPermission`, `AiPlatformPermissionName`, `AI_PLATFORM_LIMITS`, `AiPlatformRetention`, `DEFAULT_AI_PLATFORM_RETENTION`, `AiPlatformPillarOverview`, `AiPlatformOverviewResponse`, `AiPlatformFlagsResponse`, `AiPlatformRetentionResponse`.
- `server/src/custom/ai-platform/flags.ts`: `Pillar`, `PillarFlags`, `isPillarEnabled(p)`, `getFlags()`, `setFlags(patch)`, `resetFlagsCacheForTests()`. Cache 5 giây; thiếu/JSON lỗi/DB lỗi trả tất cả `false`; `setFlags` kiểm tra boolean nghiêm ngặt cho 6 khóa, giữ khóa chưa gửi, chỉ cập nhật cache sau khi ghi DB thành công.
- `server/src/custom/ai-platform/permissions.ts`: `aiPlatformPermission(method, path)` ánh xạ đầy đủ bảng `contracts/admin-api.md`; đường dẫn lạ trả `manage_ai_platform`.
- `server/src/custom/ai-platform/router.ts`: `aiPlatformRouter` với `GET /overview` (`view_ai_platform`), `PUT /flags` (`edit_ai_flags`), `GET /retention` (`view_ai_platform`), `PUT /retention` (`edit_ai_flags`). Kiểm tra quyền trực tiếp tại router (403 `code: 'missing_permission'`) và trả lỗi 400/500 thật khi input/DB lỗi.
- `server/src/custom/ai-platform/masking.ts`: `maskText(scope, text, role?)`, `maskData(scope, value, role?)`. `support_tenant` ủy quyền cho `maskSupportSensitiveText`/`maskSupportSensitiveData`; `profile`/`agent` dùng bộ che mặc định (email, phone, token), không ghi policy giả vào DB, không cho caller-role bỏ qua che.
- `server/src/custom/ai-platform/scope.ts`: `normalizeScope(scope)`, `parseScopeParam(kindRaw, idRaw)`, `purgeScope(kind, id)`. Chuẩn hóa số nguyên dương cho `profile`/`support_tenant`, giữ ID thật cho `agent`; `purgeScope` chỉ xóa khóa `ai_platform_scope_<kind>_<id>_%` trong `settings`, không đụng `ai_platform_flags_v1`/`ai_platform_retention_v1` hay bảng future chưa tồn tại.
- `server/src/db/migrations/20261113_100000_custom_ai_platform_base.ts`: `up(db)` seed `ai_platform_retention_v1` (`30/30/7`) bằng `INSERT OR IGNORE` và **không** tạo `ai_platform_flags_v1` (mọi công tắc mặc định `false`); `down(db)` xóa `settings` có `key LIKE 'ai_platform_%'`.
- Tests: `server/src/__tests__/custom/ai-platform/{flags,masking,scope}.test.ts`, `server/src/__tests__/db/migrate/ai-platform-base.test.ts`.

### EDIT
- `shared/permissions.ts`: thêm nhóm `manage_ai_platform` + 21 quyền con vào `PERMISSION_GROUPS`.
- `server/src/custom/permission-actions.ts`: thêm nhánh `if (parent === 'manage_ai_platform') return aiPlatformPermission(method, path);`.
- `server/src/services/audit-log.ts`: bổ sung `^headers$|^args$` (không phân biệt hoa/thường) vào `SECRET` để che đệ quy mọi độ sâu (< 3; độ sâu >= 3 cắt thành `'…'`). `describeRoute` giữ nguyên mọi vùng cũ và tự nhận diện `area: 'ai-platform'`.
- `server/src/db/migrate/defaults.ts`: đăng ký `20261113_100000_custom_ai_platform_base.ts` đúng thứ tự thời gian giữa `20261113_090001_support_evidence.ts` và `20261113_180001_support_service_desk.ts`.
- `server/src/__tests__/db/migrate/roundtrip.test.ts`: cập nhật danh sách kỳ vọng `DEFAULT_MIGRATIONS` đúng thứ tự.

## Xác minh T024 & Ghi chú R11 (T030)

- **T024 (`client/src/custom/PermissionsDialog.tsx`)**: Đã đọc và xác minh — component tự lọc `PERMISSION_GROUPS` (`!isXGatewayGroup(g.key)`), nên tự động hiển thị nhóm `manage_ai_platform` và 21 quyền con mà **không** cần sửa UI.
- **R11 / T030 (`purgeScope` & SQL triggers)**: `better-sqlite3` trong repo không đăng ký JS UDF cho SQL trigger nên `purgeScope` không thể gọi từ SQL trigger. Migration nền không tạo trigger trỏ tới các bảng pillar tương lai chưa tồn tại; mỗi migration pillar sau này (`20261113_110000_*`..`160000_*`) sẽ tự thêm `AFTER DELETE ON client_profiles` trên bảng của chính mình, hoặc reviewer tích hợp thêm hook gọi `purgeScope('profile', String(id))` trong `server/src/routes/client-profiles.ts` khi cần.

## Bằng chứng RED → GREEN & Lệnh kiểm tra

### RED (trước khi tạo các module cài đặt)
- Lệnh: `npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/ai-platform/flags.test.ts src/__tests__/custom/ai-platform/masking.test.ts src/__tests__/custom/ai-platform/scope.test.ts src/__tests__/db/migrate/ai-platform-base.test.ts`
- Kết quả: **4 failed suites** — `Cannot find module` cho `flags.js`, `masking.js`, `scope.js`, `20261113_100000_custom_ai_platform_base.js`.

### GREEN (sau khi cài đặt)
- `cd /tmp/wt-ai-platform-core/server && npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/ai-platform/flags.test.ts src/__tests__/custom/ai-platform/masking.test.ts src/__tests__/custom/ai-platform/scope.test.ts src/__tests__/db/migrate/ai-platform-base.test.ts src/__tests__/db/migrate/roundtrip.test.ts src/__tests__/db/migrate/registry-drift.test.ts`
  - **6 passed files, 14 passed tests, 0 failed, 0 skipped**.
- `cd /tmp/wt-ai-platform-core && npm run build -w shared` → exit `0`.
- `cd /tmp/wt-ai-platform-core && npm run build -w server` → exit `0`.
- `cd /tmp/wt-ai-platform-core && npm run lint -w server` → exit `0`.
- `cd /tmp/wt-ai-platform-core && npm run test:migrations` → exit `0` (**1 passed file, 3 passed tests**).
- `cd /tmp/wt-ai-platform-core && git diff --check` → exit `0`.

## Đề xuất cập nhật tài liệu cho Reviewer

- `specs/018-ai-platform-upgrade/plan.md`: bổ sung `server/src/db/migrate/defaults.ts` và `server/src/__tests__/db/migrate/roundtrip.test.ts` vào bảng "Điểm móc vào tệp có sẵn" (đã thực hiện ở T022).
- `specs/018-ai-platform-upgrade/research.md` mục R11: ghi rõ `purgeScope` chạy ở lớp ứng dụng và các trigger `AFTER DELETE ON client_profiles` thuộc về từng migration pillar sau này (không tạo trigger tham chiếu bảng chưa tồn tại ở migration nền).
