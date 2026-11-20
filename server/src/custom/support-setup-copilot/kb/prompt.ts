import type { KbHit } from './types.js';

/** Latest user message plus a little recent context, so follow-ups ("how do I do that?") still retrieve. */
export function buildKbQueryFromMessages(
  messages: ReadonlyArray<{ role: string; content: string }>,
  currentPath?: string,
): string {
  const users = messages.filter((m) => m.role === 'user').map((m) => m.content.trim()).filter(Boolean);
  const latest = users[users.length - 1] ?? '';
  const previous = users.length > 1 ? users[users.length - 2]!.slice(0, 200) : '';
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.content.slice(0, 200) ?? '';
  // Short follow-ups lean on the preceding turns; long questions stand alone.
  const context = latest.length < 60 ? `${previous} ${lastAssistant}` : '';
  return `${latest} ${context} ${currentPath ?? ''}`.trim();
}

/** Render retrieved chunks as a prompt section, bounded in size. */
export function formatKbForPrompt(hits: readonly KbHit[], locale: 'vi' | 'en', maxChars = 4800): string {
  if (hits.length === 0) {
    return [
      'RETRIEVED PLATFORM KNOWLEDGE: nothing relevant was found for this question.',
      'Do NOT invent pages, settings or fields. Say what you do know, then ask one short clarifying question or point to the closest area.',
    ].join('\n');
  }
  const lines: string[] = [
    'RETRIEVED PLATFORM KNOWLEDGE (ground truth from this product\'s own catalog and docs — answer from it, prefer it over memory, name the exact page path to open; if it does not cover the question, say so instead of guessing):',
  ];
  let used = lines[0]!.length;
  hits.forEach((hit, i) => {
    const c = hit.chunk;
    const title = locale === 'vi' && c.titleVi ? c.titleVi : c.title;
    const body = locale === 'vi' && c.textVi ? c.textVi : c.text;
    const where = c.path ? ` [open: ${c.path}]` : c.docFile ? ` [doc: ${c.docFile}]` : '';
    const entry = `[${i + 1}] ${title}${where}\n${body}`;
    if (used + entry.length > maxChars && i > 0) return;
    lines.push(entry.length > maxChars ? `${entry.slice(0, maxChars - 1)}…` : entry);
    used += entry.length;
  });
  return lines.join('\n\n');
}
