import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
} from '@freellmapi/shared/types.js';

export const FUSION_DEFAULTS = {
  minPanel: 2,
  stragglerGraceMs: 8000,
  panelHardTimeoutMs: 90_000,
};

const TOOL_CALL_PREFIX = '[Called tools: ';
const TOOL_RESULT_PREFIX = '[Tool result: ';

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function flattenToolHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter(Boolean)
    .map((msg) => {
      if ((msg.role as string) === 'tool' || (msg.role as string) === 'function') {
        return {
          role: 'assistant',
          content: `${TOOL_RESULT_PREFIX}${textFromContent(msg.content) || String(msg.content ?? '')}]`,
        };
      }
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const names = msg.tool_calls.map((c) => c?.function?.name || 'tool').join(', ');
        const base = textFromContent(msg.content);
        const nextContent = `${base}${base ? '\n' : ''}${TOOL_CALL_PREFIX}${names}]`;
        return { role: 'assistant', content: nextContent };
      }
      if (Array.isArray(msg.content)) {
        const hasToolBlock = msg.content.some((b: any) => b?.type === 'tool_use' || b?.type === 'tool_result');
        if (hasToolBlock) {
          const texts: string[] = [];
          const names: string[] = [];
          const results: string[] = [];
          for (const block of msg.content as Array<Record<string, any>>) {
            if (block?.type === 'text' && block.text) texts.push(block.text);
            if (block?.type === 'tool_use') names.push(block.name || 'tool');
            if (block?.type === 'tool_result') results.push(textFromContent(block.content) || String(block.content ?? ''));
          }
          let out = texts.join('\n');
          if (names.length > 0) out = `${out}${out ? '\n' : ''}${TOOL_CALL_PREFIX}${names.join(', ')}]`;
          if (results.length > 0) out = `${out}${out ? '\n' : ''}${TOOL_RESULT_PREFIX}${results.join('\n')}]`;
          return { role: msg.role, content: out };
        }
      }
      return msg;
    });
}

export function extractPanelText(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const obj = json as Record<string, any>;
  const choice = obj.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = textFromContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === 'string' && choice.text.trim()) return choice.text;
  }
  const claudeText = textFromContent(obj.content);
  if (claudeText.trim()) return claudeText;
  const parts = obj.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p: any) => p?.text || '').join('');
    if (t.trim()) return t;
  }
  if (Array.isArray(obj.output)) {
    const t = obj.output
      .flatMap((o: any) => (Array.isArray(o?.content) ? o.content.map((c: any) => c?.text || '') : []))
      .join('');
    if (t.trim()) return t;
  }
  return '';
}

export function buildJudgePrompt(answers: Array<{ model: string; text: string }>): string {
  const panel = answers.map((a, i) => `[Source ${i + 1}]\n${a.text}`).join('\n\n');
  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    '',
    'Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.',
    '',
    'First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.',
    '',
    '=== PANEL RESPONSES ===',
    panel,
    '=== END PANEL RESPONSES ===',
    '',
    "Now write the final answer to the user's original request.",
  ].join('\n');
}

export async function collectPanel<T>(
  calls: Array<Promise<T>>,
  opts: { minPanel: number; stragglerGraceMs: number; panelHardTimeoutMs: number },
  isSuccess: (v: T | undefined) => boolean,
): Promise<Array<T | { __error: unknown } | undefined>> {
  return new Promise((resolve) => {
    const out: Array<T | { __error: unknown } | undefined> = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, opts.panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled += 1;
          if (out[i] && !('__error' in (out[i] as any)) && isSuccess(out[i] as T)) ok += 1;
          if (settled === calls.length) return finish();
          if (ok >= opts.minPanel && !graceTimer) {
            graceTimer = setTimeout(finish, opts.stragglerGraceMs);
          }
        });
    });
  });
}

export async function executeJudgeFusion(opts: {
  panelTargets: string[];
  judgeModel?: string;
  messages: ChatMessage[];
  stream: boolean;
  tuning?: Partial<typeof FUSION_DEFAULTS>;
  runPanelTarget: (target: string, panelMessages: ChatMessage[]) => Promise<ChatCompletionResponse>;
  runJudgeNonStream: (judgeTarget: string, judgeMessages: ChatMessage[]) => Promise<ChatCompletionResponse>;
  runJudgeStream: (judgeTarget: string, judgeMessages: ChatMessage[]) => AsyncGenerator<ChatCompletionChunk>;
}): Promise<{ type: 'response'; response: ChatCompletionResponse } | { type: 'stream'; stream: AsyncGenerator<ChatCompletionChunk> } | null> {
  const { panelTargets, messages, stream, tuning } = opts;
  if (panelTargets.length === 0) return null;

  const judge = opts.judgeModel?.trim() || panelTargets[0];
  if (panelTargets.length === 1) {
    return stream
      ? { type: 'stream', stream: opts.runJudgeStream(panelTargets[0], messages) }
      : { type: 'response', response: await opts.runJudgeNonStream(panelTargets[0], messages) };
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning ?? {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panelTargets.length);
  const panelMessages = flattenToolHistory(messages);

  const settled = await collectPanel(
    panelTargets.map((target) => opts.runPanelTarget(target, panelMessages)),
    { minPanel, stragglerGraceMs: cfg.stragglerGraceMs, panelHardTimeoutMs: cfg.panelHardTimeoutMs },
    (res) => Boolean(extractPanelText(res).trim()),
  );

  const answers: Array<{ model: string; text: string; raw: ChatCompletionResponse }> = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    if (!res || '__error' in (res as any)) continue;
    const raw = res as ChatCompletionResponse;
    const text = extractPanelText(raw);
    if (text.trim()) answers.push({ model: panelTargets[i], text, raw });
  }

  if (answers.length === 0) return null;

  if (answers.length === 1) {
    if (!stream) return { type: 'response', response: answers[0].raw };
    async function* singleAnswerStream(): AsyncGenerator<ChatCompletionChunk> {
      const r = answers[0].raw;
      const content = r.choices?.[0]?.message?.content ?? answers[0].text;
      yield {
        id: r.id,
        object: 'chat.completion.chunk',
        created: r.created,
        model: r.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: String(content) }, finish_reason: 'stop' }],
        ...(r.usage ? { usage: r.usage } : {}),
      };
    }
    return { type: 'stream', stream: singleAnswerStream() };
  }

  const judgeMessages: ChatMessage[] = [...messages, { role: 'user', content: buildJudgePrompt(answers) }];
  if (stream) {
    return { type: 'stream', stream: opts.runJudgeStream(judge, judgeMessages) };
  }
  return { type: 'response', response: await opts.runJudgeNonStream(judge, judgeMessages) };
}
