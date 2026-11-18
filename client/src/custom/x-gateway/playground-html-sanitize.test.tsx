// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaygroundMessageContent } from './PlaygroundMessage';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('PlaygroundMessageContent HTML fragment attribute sanitization', () => {
  it('canonicalizes uppercase HTML attributes and strips dangerous protocols and overlay CSS classes', async () => {
    const payload = [
      '<div>',
      '<a HREF="javascript:alert(1)">js</a>',
      '<a HREF="vscode://evil/open">vscode</a>',
      '<a HREF="https://example.com/ok">safe</a>',
      '<img SRC="data:image/svg+xml;base64,PHN2Zy8+" />',
      '<div CLASS="fixed inset-0 z-50 x-nav-scrim bg-muted">box</div>',
      '</div>',
    ].join('');

    await act(async () => {
      root.render(<PlaygroundMessageContent content={payload} />);
    });

    const links = Array.from(container.querySelectorAll('a'));
    expect(links.length).toBe(3);
    expect(links[0]!.getAttribute('href')).toBeNull();
    expect(links[1]!.getAttribute('href')).toBeNull();
    expect(links[2]!.getAttribute('href')).toBe('https://example.com/ok');

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBeNull();

    const html = container.innerHTML;
    expect(html).not.toContain('inset-0');
    expect(html).not.toContain('z-50');
    expect(html).not.toContain('x-nav-scrim');
    expect(html).toContain('bg-muted');
  });
});
