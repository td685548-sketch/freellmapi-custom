import { apiFetch } from '@/lib/api'
import {
  DOCUMENT_MARKDOWN_LIMITS,
  RAG_UPLOAD_ACCEPT,
  type DocumentMarkdownConversionResult,
} from '../../../shared/document-markdown'

export { DOCUMENT_MARKDOWN_LIMITS, RAG_UPLOAD_ACCEPT }
export type { DocumentMarkdownConversionResult }

const SERVER_CONVERT_EXTENSIONS = new Set([
  '.docx',
  '.xlsx',
  '.xls',
  '.doc',
  '.csv',
  '.tsv',
])

export function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx).toLowerCase() : ''
}

export function shouldConvertOnServer(file: Pick<File, 'name'>): boolean {
  return SERVER_CONVERT_EXTENSIONS.has(getFileExtension(file.name))
}

export async function convertFileToMarkdown(
  endpoint: string,
  file: File,
  signal?: AbortSignal,
): Promise<DocumentMarkdownConversionResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('filename', file.name)
  return apiFetch<DocumentMarkdownConversionResult>(endpoint, {
    method: 'POST',
    body: form,
    signal,
  })
}
