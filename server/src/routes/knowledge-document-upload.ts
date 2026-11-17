import type { Request, Response } from 'express';
import multer from 'multer';
import { DOCUMENT_MARKDOWN_LIMITS } from '@freellmapi/shared/document-markdown.js';
import { convertDocumentToMarkdown, DocumentConversionError } from '../services/document-markdown.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: DOCUMENT_MARKDOWN_LIMITS.maxUploadBytes,
    files: 1,
  },
});

/**
 * Multer/Busboy decodes non-ASCII Content-Disposition filenames as latin1 by
 * default; prefer the explicit UTF-8 `filename` form field when provided or
 * recover valid UTF-8 bytes from the latin1 string.
 */
export function fixMultipartFilename(rawOriginal: string, explicitField?: unknown): string {
  if (typeof explicitField === 'string' && explicitField.trim().length > 0) {
    return explicitField.trim();
  }
  const raw = String(rawOriginal || '');
  if (!raw) return 'document';
  let allByteRange = true;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) > 0xff) {
      allByteRange = false;
      break;
    }
  }
  if (!allByteRange) return raw;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'latin1'));
  } catch {
    return raw;
  }
}

function sendConvertError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    error: {
      code,
      type: code,
      message,
    },
  });
}

export function handleKnowledgeDocumentConvert(
  req: Request,
  res: Response,
  opts?: { maxRecommendedChars?: number },
): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        sendConvertError(
          res,
          413,
          'file_too_large',
          `Uploaded file exceeds the ${DOCUMENT_MARKDOWN_LIMITS.maxUploadBytes / (1024 * 1024)} MiB size limit.`,
        );
        return;
      }
      sendConvertError(
        res,
        400,
        'invalid_input',
        err instanceof Error ? err.message : 'Malformed multipart/form-data upload.',
      );
      return;
    }

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      sendConvertError(res, 400, 'invalid_input', 'No file uploaded. Attach a file in the "file" field.');
      return;
    }

    const filename = fixMultipartFilename(file.originalname, (req.body as Record<string, unknown> | undefined)?.filename);
    try {
      const result = convertDocumentToMarkdown(file.buffer, {
        filename,
        mimeType: file.mimetype,
        maxRecommendedChars: opts?.maxRecommendedChars,
      });
      res.status(200).json(result);
    } catch (convErr) {
      if (convErr instanceof DocumentConversionError) {
        sendConvertError(res, convErr.status, convErr.code, convErr.message);
        return;
      }
      sendConvertError(res, 500, 'internal_error', 'Failed to convert document to Markdown.');
    }
  });
}
