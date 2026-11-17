/**
 * Shared constants and DTOs for converting uploaded Word, Excel, and text
 * documents to Markdown (.md) for RAG knowledge ingestion (Spec 026).
 */

export const DOCUMENT_MARKDOWN_LIMITS = {
  maxUploadBytes: 10 * 1024 * 1024,
  maxZipEntries: 2_000,
  maxEntryUncompressedBytes: 16 * 1024 * 1024,
  maxTotalUncompressedBytes: 32 * 1024 * 1024,
  maxOutputChars: 200_000,
  maxWorksheets: 50,
  maxSheetRows: 5_000,
  maxSheetCols: 100,
} as const;

export const SUPPORTED_RAG_DOCUMENT_EXTENSIONS = [
  '.docx',
  '.xlsx',
  '.xls',
  '.doc',
  '.csv',
  '.tsv',
  '.md',
  '.txt',
] as const;

export const RAG_UPLOAD_ACCEPT = SUPPORTED_RAG_DOCUMENT_EXTENSIONS.join(',');

export type DocumentSourceFormat =
  | 'docx'
  | 'xlsx'
  | 'spreadsheetml_2003'
  | 'html_office'
  | 'csv'
  | 'tsv'
  | 'markdown'
  | 'text';

export type DocumentConversionErrorCode =
  | 'empty_file'
  | 'file_too_large'
  | 'unsupported_format'
  | 'legacy_office_binary'
  | 'password_protected_document'
  | 'corrupted_archive'
  | 'empty_document';

export interface DocumentMarkdownConversionResult {
  ok: true;
  title: string;
  format: 'markdown';
  sourceFormat: DocumentSourceFormat;
  markdown: string;
  charCount: number;
  truncated: boolean;
  sheetCount?: number;
  warnings: string[];
}
