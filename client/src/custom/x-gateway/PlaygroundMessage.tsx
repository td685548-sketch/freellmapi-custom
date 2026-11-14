import React, { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Code2, Copy, Eye, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import { ARTIFACT_SANDBOX, artifactKindOf, artifactSrcDoc } from '@/lib/artifacts';
import { CodeBlock } from '@/components/code-block';
import { CopyButton } from '@/components/copy-button';
import { usePlaygroundStrings } from './playground-strings';

function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (React.isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children);
  return '';
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// Convert inline formatting (**bold**, *italic*, `code`, ~~del~~) inside HTML text nodes into HAST nodes
function parseInlineMarkdown(text: string): Array<{ type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }> {
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g;
  const parts: Array<{ type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: decodeHtmlEntities(text.slice(lastIndex, match.index)) });
    }
    lastIndex = regex.lastIndex;
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push({
        type: 'element',
        tagName: 'strong',
        properties: {},
        children: [{ type: 'text', value: decodeHtmlEntities(token.slice(2, -2)) }],
      });
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push({
        type: 'element',
        tagName: 'em',
        properties: {},
        children: [{ type: 'text', value: decodeHtmlEntities(token.slice(1, -1)) }],
      });
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push({
        type: 'element',
        tagName: 'code',
        properties: {},
        children: [{ type: 'text', value: decodeHtmlEntities(token.slice(1, -1)) }],
      });
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      parts.push({
        type: 'element',
        tagName: 'del',
        properties: {},
        children: [{ type: 'text', value: decodeHtmlEntities(token.slice(2, -2)) }],
      });
    } else {
      parts.push({ type: 'text', value: decodeHtmlEntities(token) });
    }
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: decodeHtmlEntities(text.slice(lastIndex)) });
  }

  return parts;
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

// Parse an HTML fragment into a HAST-compatible node tree
function parseHtmlFragment(rawHtml: string): HastNode[] {
  const tagRegex = /<\/?([a-zA-Z0-9_-]+)((?:\s+[a-zA-Z0-9_-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+))?)*)\s*(\/?)>/g;
  const root: HastNode = { type: 'root', children: [] };
  const stack: HastNode[] = [root];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(rawHtml)) !== null) {
    if (match.index > lastIndex) {
      const text = rawHtml.slice(lastIndex, match.index);
      if (text) {
        const inlines = parseInlineMarkdown(text);
        const current = stack[stack.length - 1];
        if (current && current.children) {
          current.children.push(...(inlines as HastNode[]));
        }
      }
    }
    lastIndex = tagRegex.lastIndex;

    const fullTag = match[0];
    const tagName = match[1].toLowerCase();
    const rawAttrs = match[2] || '';
    const isSelfClosing = match[3] === '/' || VOID_TAGS.has(tagName);
    const isClosing = fullTag.startsWith('</');

    if (isClosing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tagName) {
          stack.splice(i);
          break;
        }
      }
    } else {
      const properties: Record<string, unknown> = {};
      const attrRegex = /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
        const key = attrMatch[1];
        const val =
          attrMatch[2] !== undefined
            ? attrMatch[2]
            : attrMatch[3] !== undefined
            ? attrMatch[3]
            : attrMatch[4] !== undefined
            ? attrMatch[4]
            : attrMatch[5] !== undefined
            ? attrMatch[5]
            : true;
        properties[key] = val;
      }

      const elementNode: HastNode = {
        type: 'element',
        tagName,
        properties,
        children: [],
      };

      const parent = stack[stack.length - 1];
      if (parent && parent.children) {
        parent.children.push(elementNode);
      }

      if (!isSelfClosing) {
        stack.push(elementNode);
      }
    }
  }

  if (lastIndex < rawHtml.length) {
    const trailingText = rawHtml.slice(lastIndex);
    if (trailingText) {
      const inlines = parseInlineMarkdown(trailingText);
      const current = stack[stack.length - 1];
      if (current && current.children) {
        current.children.push(...(inlines as HastNode[]));
      }
    }
  }

  return root.children || [];
}

// Rehype plugin: transforms 'raw' HTML nodes into proper HAST element trees
function rehypeRawHtml() {
  return (tree: HastNode) => {
    function visit(node: HastNode) {
      if (!node.children || !Array.isArray(node.children)) return;
      const nextChildren: HastNode[] = [];
      for (const child of node.children) {
        if (child.type === 'raw' && typeof child.value === 'string') {
          const parsed = parseHtmlFragment(child.value);
          for (const p of parsed) {
            visit(p);
            nextChildren.push(p);
          }
        } else {
          visit(child);
          nextChildren.push(child);
        }
      }
      node.children = nextChildren;
    }
    visit(tree);
  };
}

// Interactive button component supporting click-to-copy
interface CustomButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
  variant?: string;
  size?: string;
}

function CustomButton({ children, className, title, onClick, ...props }: CustomButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (onClick) {
      onClick(e);
      return;
    }
    const text = nodeText(children).trim();
    if (text) {
      void copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={title || 'Copy'}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-border bg-muted/60 hover:bg-muted text-foreground transition cursor-pointer',
        className,
      )}
      {...props}
    >
      {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
      <span>{copied ? 'Copied' : children}</span>
    </button>
  );
}

function extractHtmlTitle(code: string): string | null {
  const match = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(code);
  const title = match?.[1]?.trim();
  return title || null;
}

function PlaygroundCodePre({ children }: { children?: React.ReactNode }) {
  const s = usePlaygroundStrings();
  const [previewOpen, setPreviewOpen] = useState(false);

  const childProps = React.isValidElement(children)
    ? (children.props as { className?: string; language?: string })
    : undefined;
  const langMatch = /language-([^\s]+)/.exec(childProps?.className || '');
  const language = (langMatch?.[1] || childProps?.language || '').toLowerCase();
  const codeText = nodeText(children).trimEnd();
  const artifactKind = artifactKindOf(language, codeText);

  useEffect(() => {
    if (!previewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewOpen]);

  const previewTitle = artifactKind ? extractHtmlTitle(codeText) || s.htmlPreviewTitle : s.htmlPreviewTitle;
  const srcDoc = artifactKind
    ? artifactSrcDoc({
        id: 'preview',
        kind: artifactKind,
        language,
        code: codeText,
        title: previewTitle,
        filename: artifactKind === 'svg' ? 'preview.svg' : 'preview.html',
      })
    : '';

  return (
    <div className="relative group my-2.5">
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
        {artifactKind && (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            aria-label={s.previewHtml}
            title={s.previewHtml}
            className="inline-flex items-center gap-1 rounded-md border bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
          >
            <Eye className="size-3.5" />
            <span>{s.previewHtml}</span>
          </button>
        )}
        <CopyButton text={codeText} className="size-7" />
      </div>
      <div className="rounded-xl overflow-hidden border border-border bg-muted/40 text-foreground font-mono text-xs">
        {children}
      </div>
      {previewOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={previewTitle}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 sm:p-6"
            onClick={event => {
              if (event.target === event.currentTarget) setPreviewOpen(false);
            }}
          >
            <div className="flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
              <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-2.5">
                <span className="truncate text-sm font-semibold text-foreground">{previewTitle}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setPreviewOpen(false)}
                    aria-label={s.backToCode}
                    title={s.backToCode}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted cursor-pointer"
                  >
                    <Code2 className="size-3.5" />
                    <span>{s.backToCode}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewOpen(false)}
                    aria-label={s.closePreview}
                    title={s.closePreview}
                    className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>
              <iframe
                title={previewTitle}
                sandbox={ARTIFACT_SANDBOX}
                srcDoc={srcDoc}
                className="w-full flex-1 border-0 bg-white"
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

const baseComponents: Components = {
  p: ({ children }) => (
    <p className="my-2 first:mt-0 last:mb-0 leading-relaxed wrap-break-word">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-xl font-bold tracking-tight text-foreground first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3.5 mb-2 text-base font-bold tracking-tight text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold text-foreground first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2.5 mb-1.5 text-xs font-semibold text-foreground first:mt-0">
      {children}
    </h4>
  ),
  ul: ({ children }) => (
    <ul className="my-2 ml-5 list-disc space-y-1 [&_ul]:my-1 [&_ol]:my-1 first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-5 list-decimal space-y-1 [&_ul]:my-1 [&_ol]:my-1 first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-primary/40 pl-3 italic text-muted-foreground first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  b: ({ children }) => <b className="font-semibold text-foreground">{children}</b>,
  em: ({ children }) => <em className="italic">{children}</em>,
  i: ({ children }) => <i className="italic">{children}</i>,
  del: ({ children }) => <del className="opacity-70">{children}</del>,
  s: ({ children }) => <s className="opacity-70">{children}</s>,
  u: ({ children }) => <span className="underline underline-offset-2">{children}</span>,
  mark: ({ children }) => (
    <mark className="bg-amber-200/50 dark:bg-amber-500/25 px-1 py-0.5 rounded text-foreground">
      {children}
    </mark>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:opacity-85 font-medium"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs text-left border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50 border-b border-border">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-border/60 hover:bg-muted/20 transition-colors">{children}</tr>,
  th: ({ children }) => (
    <th className="border border-border px-2.5 py-1.5 font-semibold text-foreground bg-muted/30">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-border px-2.5 py-1.5 align-top">{children}</td>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || '');
    const isInline = !match && !String(children).includes('\n');
    if (isInline) {
      return (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground" {...props}>
          {children}
        </code>
      );
    }
    return (
      <CodeBlock language={match ? match[1] : 'text'} code={nodeText(children).trimEnd()} />
    );
  },
  pre: ({ children }) => <PlaygroundCodePre>{children}</PlaygroundCodePre>,
  details: ({ children }) => (
    <details className="my-2 rounded-lg border border-border p-2 bg-muted/20 text-xs">
      {children}
    </details>
  ),
  summary: ({ children }) => (
    <summary className="cursor-pointer font-medium text-foreground select-none">
      {children}
    </summary>
  ),
  button: CustomButton as unknown as Components['button'],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const customComponents: Components = {
  ...baseComponents,
  // Custom UI components used by LLMs (e.g. 9Router / Claude / GPT custom tags)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: ({ children, align, justify, gap, className }: any) => {
    const alignStr = String(align || '').toLowerCase();
    const justifyStr = String(justify || '').toLowerCase();
    const gapStr = String(gap || '').replace(/[{}]/g, '');

    const alignCls =
      alignStr === 'center' ? 'items-center' :
      alignStr === 'end' ? 'items-end' :
      alignStr === 'start' ? 'items-start' : 'items-center';

    const justifyCls =
      justifyStr === 'center' ? 'justify-center' :
      justifyStr === 'end' ? 'justify-end' :
      justifyStr === 'between' ? 'justify-between' : 'justify-start';

    const gapCls =
      gapStr === '1' ? 'gap-1' :
      gapStr === '3' ? 'gap-3' :
      gapStr === '4' ? 'gap-4' : 'gap-2';

    return (
      <div className={cn('flex flex-row flex-wrap my-1.5', alignCls, justifyCls, gapCls, className)}>
        {children}
      </div>
    );
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  box: ({ children, radius, padding, gap, className }: any) => {
    const radStr = String(radius || '').toLowerCase();
    const padStr = String(padding || '').replace(/[{}]/g, '');
    const gapStr = String(gap || '').replace(/[{}]/g, '');

    const radCls =
      radStr === 'sm' ? 'rounded-md' :
      radStr === 'md' ? 'rounded-lg' :
      radStr === 'full' ? 'rounded-full' : 'rounded-xl';

    const padCls =
      padStr === '1' ? 'p-2' :
      padStr === '2' ? 'p-2.5' :
      padStr === '4' ? 'p-4' : 'p-3';

    const gapCls =
      gapStr === '1' ? 'gap-1.5' :
      gapStr === '3' ? 'gap-3' : 'gap-2';

    return (
      <div className={cn('my-2.5 rounded-xl border border-border/80 bg-card/60 dark:bg-muted/20 flex flex-col text-foreground shadow-xs', radCls, padCls, gapCls, className)}>
        {children}
      </div>
    );
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  badge: ({ children, color, variant, className }: any) => {
    const c = String(color || variant || '').toLowerCase();
    let colorCls = 'bg-muted text-muted-foreground border-border';
    if (c.includes('success') || c.includes('green')) {
      colorCls = 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
    } else if (c.includes('warn') || c.includes('yellow')) {
      colorCls = 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30';
    } else if (c.includes('err') || c.includes('danger') || c.includes('red')) {
      colorCls = 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30';
    } else if (c.includes('info') || c.includes('blue') || c.includes('primary')) {
      colorCls = 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30';
    }
    return (
      <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border', colorCls, className)}>
        {children}
      </span>
    );
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  title: ({ children, size, color, tabularNums, className }: any) => {
    const s = String(size || '').toLowerCase();
    let sizeCls = 'text-base font-bold';
    if (s === 'sm') sizeCls = 'text-xs font-semibold';
    else if (s === 'md') sizeCls = 'text-sm font-semibold';
    else if (s === 'lg') sizeCls = 'text-base font-bold';
    else if (s === 'xl') sizeCls = 'text-xl font-bold';
    else if (s === '2xl') sizeCls = 'text-2xl font-bold';
    else if (s === '3xl') sizeCls = 'text-3xl font-extrabold';

    const c = String(color || '').toLowerCase();
    let colorCls = 'text-foreground';
    if (c.includes('success')) colorCls = 'text-emerald-600 dark:text-emerald-400';
    else if (c.includes('warn')) colorCls = 'text-amber-600 dark:text-amber-400';
    else if (c.includes('err') || c.includes('danger')) colorCls = 'text-rose-600 dark:text-rose-400';
    else if (c.includes('primary')) colorCls = 'text-primary';

    const isTabular = tabularNums !== undefined && tabularNums !== false && tabularNums !== 'false';

    return (
      <div className={cn(sizeCls, colorCls, isTabular && 'tabular-nums', className)}>
        {children}
      </div>
    );
  },
} as unknown as Components;

interface PlaygroundMessageContentProps {
  content: string;
  isGenerating?: boolean;
  generatingLabel?: string;
  className?: string;
}

function PlaygroundMessageContentInner({
  content,
  isGenerating = false,
  generatingLabel = 'Generating…',
  className,
}: PlaygroundMessageContentProps) {
  if (!content && isGenerating) {
    return (
      <div className="x-typing" role="status">
        <span /><span /><span />
        <span className="x-sr-only">{generatingLabel}</span>
      </div>
    );
  }

  if (!content) {
    return null;
  }

  return (
    <div className={cn('x-playground-content text-sm leading-relaxed text-foreground', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRawHtml]}
        remarkRehypeOptions={{ allowDangerousHtml: true }}
        components={customComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const PlaygroundMessageContent = memo(PlaygroundMessageContentInner);
