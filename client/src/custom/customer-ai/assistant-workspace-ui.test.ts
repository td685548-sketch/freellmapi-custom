import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  detectAssistantArtifacts,
  sanitizeArtifactHtml,
  sanitizeArtifactSvg,
} from '../../../../shared/customer-ai';
import { formatWorkspaceString, getWorkspaceStrings } from './strings';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('Personal AI Agent Workspace UI & Bilingual Strings (Spec 038)', () => {
  it('maintains 100% Vietnamese and English dictionary parity with placeholder interpolation', () => {
    const en = getWorkspaceStrings('en');
    const vi = getWorkspaceStrings('vi');

    expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(en[key].trim().length).toBeGreaterThan(0);
      expect(vi[key].trim().length).toBeGreaterThan(0);
    }

    expect(formatWorkspaceString(vi.myAssistantsCount, { count: 3, max: 20 })).toBe('3/20 trợ lý');
    expect(formatWorkspaceString(en.myAssistantsCount, { count: 3, max: 20 })).toBe('3/20 agents');
  });

  it('wires CustomAgentModal, Saved Threads + Fork Thread, and CSP-safe ArtifactPreviewPanel', () => {
    const hubSource = readFileSync(path.join(here, 'CustomerAiHubPage.tsx'), 'utf8');
    const drawerSource = readFileSync(path.join(here, 'AssistantChatDrawer.tsx'), 'utf8');
    const artifactPanelSource = readFileSync(path.join(here, 'ArtifactPreviewPanel.tsx'), 'utf8');

    expect(hubSource).toContain('<CustomAgentModal');
    expect(hubSource).toContain('<QuotaCoachCard />');
    expect(drawerSource).toContain('postBranchAssistantThread');
    expect(drawerSource).toContain('streamAssistantChat');
    expect(drawerSource).toContain('<ArtifactPreviewPanel');

    // Verify CSP safety: never embeds raw unsanitized iframe inline scripts
    expect(artifactPanelSource).toContain('sanitizeArtifactHtml');
    expect(artifactPanelSource).toContain('sanitizeArtifactSvg');
    expect(artifactPanelSource).not.toContain('<iframe');
  });

  it('strips dangerous XSS payloads from SVG and HTML artifacts', () => {
    const artifacts = detectAssistantArtifacts(
      '```svg\n<svg onload="alert(1)"><script>evil()</script><circle cx="20" cy="20" r="10" /></svg>\n```',
      'ui',
    );
    expect(artifacts).toHaveLength(1);
    const svg = sanitizeArtifactSvg(artifacts[0]!.content);
    expect(svg).toContain('<circle cx="20" cy="20" r="10" />');
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('script');

    const html = sanitizeArtifactHtml(
      '<table onmouseover="x()"><tr><td>Safe</td></tr></table><img src="x" onerror="alert(1)" />',
    );
    expect(html).toContain('<table><tr><td>Safe</td></tr></table>');
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('onerror');
  });
});
