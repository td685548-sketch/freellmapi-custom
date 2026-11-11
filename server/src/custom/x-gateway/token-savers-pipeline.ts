import type { Request, Response } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { isRtkEnabled, compressMessages } from './rtk.js';
import { isHeadroomPhantomSavings, compressWithHeadroom } from './headroom.js';
import { isPxpipeEnabled, isVisionCapableModel, compressMessagesWithPxpipeVision } from './pxpipe.js';
import { readOutputSaverSettings } from '../output-savers/config.js';
import { buildSaverBlock } from '../output-savers/prompts.js';

export const PIPELINE_APPLIED_SYMBOL = Symbol('X_GATEWAY_TOKEN_SAVERS_PREPROCESSED');

export interface PreprocessPipelineOptions {
  messages: ChatMessage[];
  rawBody?: Record<string, any>;
  requestedModel?: string;
  targetModel?: string;
  targetProvider?: string;
  format?: 'openai' | 'claude' | 'gemini' | 'openai-responses';
  signal?: AbortSignal;
}

export interface PreprocessPipelineResult {
  messages: ChatMessage[];
  textOnlyMessages: ChatMessage[];
  appliedSavers: string[];
  tokensSavedEst: number;
  rtkTokensSavedEst: number;
  headroomTokensSavedEst: number;
  pxpipeTokensSavedEst: number;
  outputSaverApplied?: string;
  injectedOutputChars: number;
}

function isBypassedByHeader(req: Request | undefined, headerName: string): boolean {
  if (!req) return false;
  const val = req.headers[headerName.toLowerCase()];
  if (typeof val === 'string') {
    const v = val.trim().toLowerCase();
    if (headerName.toLowerCase().startsWith('x-disable-')) {
      return v === '1' || v === 'true' || v === 'yes' || v === 'on';
    }
    return v === 'off' || v === '0' || v === 'false' || v === 'no' || v === 'disable' || v === 'disabled';
  }
  return false;
}

export function isTokenSaversBypassed(req?: Request): {
  allInputBypassed: boolean;
  outputBypassed: boolean;
  rtkBypassed: boolean;
  headroomBypassed: boolean;
  pxpipeBypassed: boolean;
} {
  const globalBypass =
    isBypassedByHeader(req, 'x-disable-savers') ||
    isBypassedByHeader(req, 'x-disable-saver') ||
    isBypassedByHeader(req, 'x-9router-token-saver') ||
    isBypassedByHeader(req, 'x-token-saver') ||
    isBypassedByHeader(req, 'x-freellm-saver');

  const outputBypass =
    globalBypass ||
    isBypassedByHeader(req, 'x-disable-output-savers') ||
    isBypassedByHeader(req, 'x-disable-output-saver') ||
    isBypassedByHeader(req, 'x-output-saver') ||
    isBypassedByHeader(req, 'x-output-savers');

  const rtkBypass =
    globalBypass ||
    isBypassedByHeader(req, 'x-disable-rtk') ||
    isBypassedByHeader(req, 'x-disable-rtk-saver') ||
    isBypassedByHeader(req, 'x-rtk') ||
    isBypassedByHeader(req, 'x-rtk-saver');

  const headroomBypass =
    globalBypass ||
    isBypassedByHeader(req, 'x-disable-headroom') ||
    isBypassedByHeader(req, 'x-disable-headroom-saver') ||
    isBypassedByHeader(req, 'x-headroom') ||
    isBypassedByHeader(req, 'x-headroom-saver');

  const pxpipeBypass =
    globalBypass ||
    isBypassedByHeader(req, 'x-disable-pxpipe') ||
    isBypassedByHeader(req, 'x-disable-pxpipe-saver') ||
    isBypassedByHeader(req, 'x-pxpipe') ||
    isBypassedByHeader(req, 'x-pxpipe-saver');

  return {
    allInputBypassed: globalBypass,
    outputBypassed: outputBypass,
    rtkBypassed: rtkBypass,
    headroomBypassed: headroomBypass,
    pxpipeBypassed: pxpipeBypass,
  };
}

/**
 * Preprocesses inference messages across Chat, Messages, Responses, and Gemini routes.
 * Enforces idempotency (guards against double compression) and sets honest response headers.
 */
export async function preprocessGatewayMessages(
  req: Request | undefined,
  res: Response | undefined,
  options: PreprocessPipelineOptions
): Promise<PreprocessPipelineResult> {
  if (req && (req as any)[PIPELINE_APPLIED_SYMBOL]) {
    return (req as any)[PIPELINE_APPLIED_SYMBOL] as PreprocessPipelineResult;
  }

  const {
    allInputBypassed,
    outputBypassed,
    rtkBypassed,
    headroomBypassed,
    pxpipeBypassed,
  } = isTokenSaversBypassed(req);

  const model = options.targetModel || options.requestedModel || 'unknown';
  const provider = options.targetProvider;

  let messages: ChatMessage[] = structuredClone(options.messages);
  const appliedSavers: string[] = [];
  let rtkTokensSavedEst = 0;
  let headroomTokensSavedEst = 0;
  let pxpipeTokensSavedEst = 0;
  let outputSaverApplied: string | undefined;
  let injectedOutputChars = 0;

  // 1. RTK (Runtime Tool-Result Compressor)
  if (!allInputBypassed && !rtkBypassed && isRtkEnabled()) {
    try {
      const targetBody = { messages };
      const rtkRes = compressMessages(targetBody);
      if (rtkRes && rtkRes.hits.length > 0) {
        const savedBytes = Math.max(0, rtkRes.bytesBefore - rtkRes.bytesAfter);
        rtkTokensSavedEst = Math.max(1, Math.round(savedBytes / 4));
        appliedSavers.push('RTK');
        if (Array.isArray(targetBody.messages)) {
          messages = targetBody.messages as ChatMessage[];
        }
      }
    } catch {
      // Fail open
    }
  }

  // 2. Headroom (/v1/compress external proxy)
  if (!allInputBypassed && !headroomBypassed) {
    try {
      const targetBody = { messages };
      const headroomRes = await compressWithHeadroom(targetBody, {
        model,
        signal: options.signal,
      });

      if (headroomRes && !isHeadroomPhantomSavings(headroomRes)) {
        headroomTokensSavedEst = headroomRes.tokensSavedEst;
        appliedSavers.push('Headroom');
        if (Array.isArray(targetBody.messages)) {
          messages = targetBody.messages as ChatMessage[];
        }
      }
    } catch {
      // Fail open
    }
  }

  // 3. Output Savers (Caveman, Ponytail, CustomPrompt)
  if (!outputBypassed) {
    try {
      const { levels, customPrompt } = readOutputSaverSettings();
      const saverBlock = buildSaverBlock(levels, customPrompt);
      if (saverBlock && saverBlock.trim().length > 0) {
        injectedOutputChars = saverBlock.length;
        const appliedTokens: string[] = [];
        if (levels.caveman && levels.caveman !== 'off') appliedTokens.push(`caveman(${levels.caveman})`);
        if (levels.ponytail && levels.ponytail !== 'off') appliedTokens.push(`ponytail(${levels.ponytail})`);
        if (customPrompt && customPrompt.trim()) appliedTokens.push('customPrompt');
        outputSaverApplied = appliedTokens.join(', ');
        appliedSavers.push(outputSaverApplied);

        const systemIndex = messages.findIndex(m => m.role === 'system' || (m.role as string) === 'developer');
        if (systemIndex >= 0) {
          const orig = messages[systemIndex];
          const origText = typeof orig.content === 'string' ? orig.content : '';
          messages[systemIndex] = {
            ...orig,
            content: `${origText}\n\n${saverBlock}`.trim(),
          };
        } else {
          messages.unshift({
            role: 'system',
            content: saverBlock.trim(),
          });
        }
      }
    } catch {
      // Fail open
    }
  }

  const textOnlyMessages = JSON.parse(JSON.stringify(messages));

  // 4. PXPIPE Text-to-Image Vision Context Compressor
  if (!allInputBypassed && !pxpipeBypassed && isPxpipeEnabled()) {
    try {
      if (isVisionCapableModel(model, provider)) {
        const pxResult = compressMessagesWithPxpipeVision(messages, {
          model,
          provider,
          format: 'openai',
        });

        if (pxResult.summary.applied) {
          messages = pxResult.messages as ChatMessage[];
          pxpipeTokensSavedEst = pxResult.summary.tokensSavedEst;
          appliedSavers.push(`PXPIPE(${pxResult.summary.imageCount}img)`);
        }
      }
    } catch {
      // Fail open
    }
  }

  const totalTokensSavedEst = rtkTokensSavedEst + headroomTokensSavedEst + pxpipeTokensSavedEst;

  const result: PreprocessPipelineResult = {
    messages: messages as ChatMessage[],
    textOnlyMessages: textOnlyMessages as ChatMessage[],
    appliedSavers,
    tokensSavedEst: totalTokensSavedEst,
    rtkTokensSavedEst,
    headroomTokensSavedEst,
    pxpipeTokensSavedEst,
    outputSaverApplied,
    injectedOutputChars,
  };

  if (req) {
    (req as any)[PIPELINE_APPLIED_SYMBOL] = result;
  }

  if (res && !res.headersSent) {
    res.setHeader('X-Token-Savers-Applied', appliedSavers.length > 0 ? appliedSavers.join(', ') : 'none');
    if (outputSaverApplied) {
      res.setHeader('X-Output-Saver-Applied', outputSaverApplied);
    }
    if (totalTokensSavedEst > 0) {
      res.setHeader('X-Input-Tokens-Saved', String(totalTokensSavedEst));
    }
    if (rtkTokensSavedEst > 0) {
      res.setHeader('X-RTK-Saved-Tokens-Est', String(rtkTokensSavedEst));
    }
    if (headroomTokensSavedEst > 0) {
      res.setHeader('X-Headroom-Saved-Tokens-Est', String(headroomTokensSavedEst));
    }
    if (pxpipeTokensSavedEst > 0) {
      res.setHeader('X-Pxpipe-Saved-Tokens-Est', String(pxpipeTokensSavedEst));
    }
    if (injectedOutputChars > 0) {
      res.setHeader('X-Output-Chars-Injected', String(injectedOutputChars));
    }
  }

  return result;
}
