# Implementation Plan: Automatic Word & Excel to Markdown (.md) Conversion for RAG Uploads (Spec 025)

**Branch**: `feat/025-rag-office-markdown` | **Date**: 2026-11-18 | **Spec**: [spec.md](./spec.md)

## Architecture & Module Map (Zero-Conflict Modular Design)

1. **Shared Contracts (`shared/document-markdown.ts`)**:
   - Limits (`DOCUMENT_MARKDOWN_LIMITS`), accepted extensions (`RAG_UPLOAD_ACCEPT`), and result/error DTOs (`DocumentMarkdownConversionResult`, `DocumentSourceFormat`, `DocumentConversionErrorCode`).
2. **Standalone Converter Service (`server/src/services/document-markdown.ts`)**:
   - Zero-dependency ZIP reader via `node:zlib` (`inflateRawSync` bounded by `maxOutputLength`, ZIP64/encrypted entry/path-traversal guards, skips `word/media/*` & `xl/media/*` without decompression).
   - Safe lightweight XML tree parser without DTD/XXE evaluation.
   - DOCX -> GFM Markdown (`styles.xml` heading/quote/code/inheritance, `numbering.xml` nested ordered/bullet lists, merged inline spans, safe `document.xml.rels` links, GFM tables with `gridSpan`, Track Changes exclusion, footnotes/endnotes).
   - XLSX -> GFM Markdown (`workbook.xml` + `workbook.xml.rels` sheet ordering & hidden-sheet filtering, `sharedStrings.xml` rich text without phonetic ruby runs, `styles.xml` date serials & percentage formatting, sparse coordinates).
   - CSV (`;` / `,` auto-detect), TSV, SpreadsheetML 2003, HTML Office export, Markdown, and UTF-8/UTF-16 text normalization, plus structured `415 legacy_office_binary` and `415 password_protected_document` errors.
3. **Standalone Upload Middleware & Minimal Router Mounts**:
   - `server/src/routes/knowledge-document-upload.ts` (`multer.memoryStorage()`, Busboy UTF-8 filename recovery, unified error envelope).
   - Minimal `POST .../convert` endpoints added to `profile-knowledge.ts`, `support-evidence-router.ts`, and `support-enterprise-router.ts` inheriting existing RBAC gates.
4. **Client Helper, UI Integration & Bilingual EN/VI Strings**:
   - `client/src/custom/document-markdown-upload.ts`
   - Integrated into `KnowledgeCard.tsx` (+ `vi.ts`), `SupportKnowledgeStudio.tsx` (+ `support-evidence-strings.ts`), and `SupportEnterprise.tsx` (+ `support-enterprise-strings.ts`).
