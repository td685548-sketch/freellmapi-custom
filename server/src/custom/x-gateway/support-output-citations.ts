import type { SupportEvidenceCitation } from '@freellmapi/shared/support-evidence.js';

/** Restore only previously validated ordinals; unknown references remain invalid. */
export function restoreSupportOutputCitationMarkers(text: string, citations: SupportEvidenceCitation[]): string {
  const byOrdinal = new Map(citations.map(c => [String(c.ordinal), c.id]));
  return text.replace(/\[([1-9]\d*)\]/g, (marker, ordinal: string) => {
    const id = byOrdinal.get(ordinal);
    return id ? `[cite:${id}]` : marker;
  });
}

/** Revalidation refreshes provenance, but must not resurrect redacted source text. */
export function retainSupportOutputCitationText(
  validated: SupportEvidenceCitation[],
  sanitized: SupportEvidenceCitation[],
): SupportEvidenceCitation[] {
  const safeById = new Map(sanitized.map(c => [c.id, c]));
  return validated.map(c => {
    const safe = safeById.get(c.id);
    if (!safe) throw new Error('Output citation provenance changed.');
    return { ...c, title: safe.title, excerpt: safe.excerpt };
  });
}
