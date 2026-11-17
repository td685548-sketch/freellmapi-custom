# Tasks: Tự động chuyển đổi Word & Excel sang Markdown (.md) cho RAG (Spec 026)

**Directory**: `specs/026-rag-office-markdown` | **Plan**: [plan.md](./plan.md)

- [x] **T001** Tạo shared constants & DTOs tại `shared/document-markdown.ts` và biên dịch `@freellmapi/shared`.
- [x] **T002** Xây dựng bộ chuyển đổi không phụ thuộc ngoài tại `server/src/services/document-markdown.ts` (DOCX, XLSX, CSV/TSV, SpreadsheetML 2003, HTML Office, bảo vệ zip-bomb/XXE/encrypted/OLE2).
- [x] **T003** Tạo middleware upload `server/src/routes/knowledge-document-upload.ts` (sửa mã hóa tên tệp UTF-8) và gắn endpoint `POST .../convert` vào `profile-knowledge.ts`, `support-evidence-router.ts`, `support-enterprise-router.ts`.
- [x] **T004** Tạo helper `client/src/custom/document-markdown-upload.ts` và tích hợp upload tự động chuyển Markdown vào `KnowledgeCard.tsx`, `SupportKnowledgeStudio.tsx`, `SupportEnterprise.tsx` kèm đầy đủ chuỗi song ngữ EN/VI (`vi.ts`, `support-evidence-strings.ts`, `support-enterprise-strings.ts`).
- [x] **T005** Viết unit tests (`server/src/__tests__/custom/document-markdown.test.ts`), HTTP/RAG integration tests (`server/src/__tests__/custom/knowledge-office-upload-http.test.ts`), và UI tests (`KnowledgeCard.test.tsx`, `support-evidence.test.tsx`, `support-enterprise.test.tsx`); chạy kiểm chứng toàn bộ lint, test, và build.
