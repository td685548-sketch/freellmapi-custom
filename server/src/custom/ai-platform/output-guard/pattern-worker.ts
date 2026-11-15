import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

export interface WorkerPatternRule {
  id: string;
  name: string;
  pattern: string;
  flags: string;
}

export interface WorkerPatternMatch {
  id: string;
  name: string;
  start: number;
  end: number;
  match: string;
}

export type PatternWorkerPayload =
  | {
      mode: 'validate';
      rules: WorkerPatternRule[];
      samples: string[];
    }
  | {
      mode: 'eval';
      rules: WorkerPatternRule[];
      text: string;
      maxMatches?: number;
    };

export type PatternWorkerRequest = PatternWorkerPayload & { jobId: number };

export type PatternWorkerResponse =
  | {
      jobId: number;
      ok: true;
      evalMs: number;
      matches?: WorkerPatternMatch[];
    }
  | {
      jobId: number;
      ok: false;
      evalMs: number;
      errorCode: 'invalid_pattern' | 'eval_error';
      message: string;
    };

function sanitizeFlags(rawFlags: string, forceGlobal: boolean): string {
  const allowed = new Set<string>();
  for (const ch of rawFlags) {
    if (ch === 'i' || ch === 'm' || ch === 's' || ch === 'u') {
      allowed.add(ch);
    }
  }
  if (forceGlobal) allowed.add('g');
  return [...allowed].join('');
}

if (parentPort) {
  parentPort.on('message', (req: PatternWorkerRequest) => {
    const start = performance.now();
    try {
      if (req.mode === 'validate') {
        let maxEvalMs = 0;
        for (const rule of req.rules) {
          const flags = sanitizeFlags(rule.flags, false);
          let re: RegExp;
          try {
            re = new RegExp(rule.pattern, flags);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'invalid regex';
            parentPort!.postMessage({
              jobId: req.jobId,
              ok: false,
              evalMs: performance.now() - start,
              errorCode: 'invalid_pattern',
              message: msg,
            } satisfies PatternWorkerResponse);
            return;
          }
          for (const sample of req.samples) {
            const t0 = performance.now();
            re.lastIndex = 0;
            re.exec(sample);
            const dt = performance.now() - t0;
            if (dt > maxEvalMs) maxEvalMs = dt;
          }
        }
        parentPort!.postMessage({
          jobId: req.jobId,
          ok: true,
          evalMs: maxEvalMs,
        } satisfies PatternWorkerResponse);
        return;
      }

      const matches: WorkerPatternMatch[] = [];
      const maxMatches = req.maxMatches ?? 50;
      const t0 = performance.now();
      for (const rule of req.rules) {
        const flags = sanitizeFlags(rule.flags, true);
        let re: RegExp;
        try {
          re = new RegExp(rule.pattern, flags);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'invalid regex';
          parentPort!.postMessage({
            jobId: req.jobId,
            ok: false,
            evalMs: performance.now() - t0,
            errorCode: 'invalid_pattern',
            message: msg,
          } satisfies PatternWorkerResponse);
          return;
        }
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(req.text)) !== null) {
          const matchedText = m[0];
          if (matchedText.length > 0) {
            matches.push({
              id: rule.id,
              name: rule.name,
              start: m.index,
              end: m.index + matchedText.length,
              match: matchedText,
            });
            if (matches.length >= maxMatches) break;
          } else {
            re.lastIndex += 1;
          }
          if (re.lastIndex > req.text.length) break;
        }
        if (matches.length >= maxMatches) break;
      }
      parentPort!.postMessage({
        jobId: req.jobId,
        ok: true,
        evalMs: performance.now() - t0,
        matches,
      } satisfies PatternWorkerResponse);
    } catch (err) {
      parentPort!.postMessage({
        jobId: req.jobId,
        ok: false,
        evalMs: performance.now() - start,
        errorCode: 'eval_error',
        message: err instanceof Error ? err.message : 'regex evaluation failed',
      } satisfies PatternWorkerResponse);
    }
  });
  parentPort.postMessage({ type: 'ready' });
}
