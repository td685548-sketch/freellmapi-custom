import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bot, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import { useCustomT } from '../i18n/use-custom-t';
import { postAssistantChat } from './api';
import type { CustomerAiAssistant, KeyRoutingMode } from '../../../../shared/customer-ai';

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  model?: string | null;
  routingMode?: KeyRoutingMode;
}

const MODE_LABELS: Record<KeyRoutingMode, string> = {
  default: 'Recommended',
  eco: 'Eco (Fast)',
  balanced: 'Balanced',
  max: 'Max Quality',
};

export function AssistantChatDrawer({
  assistant,
  onClose,
}: {
  assistant: CustomerAiAssistant | null;
  onClose: () => void;
}) {
  if (!assistant) return null;
  return <AssistantChatDrawerContent key={assistant.slug} assistant={assistant} onClose={onClose} />;
}

function AssistantChatDrawerContent({
  assistant,
  onClose,
}: {
  assistant: CustomerAiAssistant;
  onClose: () => void;
}) {
  const tc = useCustomT();
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [routingMode, setRoutingMode] = useState<KeyRoutingMode>(
    assistant.recommendedRoutingMode === 'default' ? 'balanced' : assistant.recommendedRoutingMode,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sendMutation = useMutation({
    mutationFn: (turns: Array<{ role: 'user' | 'assistant'; content: string }>) =>
      postAssistantChat(assistant.slug, {
        messages: turns,
        routingMode,
      }),
    onSuccess: (res) => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: res.reply,
          model: res.model,
          routingMode: res.routingMode,
        },
      ]);
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Assistant chat failed'));
    },
  });

  const submitText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sendMutation.isPending) return;
    const nextTurns: ChatEntry[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextTurns);
    setInput('');
    sendMutation.mutate(nextTurns.map(m => ({ role: m.role, content: m.content })));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={assistant.name}
        className="flex h-[min(85vh,44rem)] w-full max-w-2xl flex-col rounded-3xl border bg-card shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-primary shrink-0" />
              <h2 className="text-sm font-semibold truncate">{assistant.name}</h2>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">{assistant.description}</p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <select
              aria-label={tc('Routing mode')}
              value={routingMode}
              onChange={(e) => setRoutingMode(e.target.value as KeyRoutingMode)}
              className="h-8 rounded-lg border bg-background px-2 text-xs"
            >
              <option value="eco">{tc(MODE_LABELS.eco)}</option>
              <option value="balanced">{tc(MODE_LABELS.balanced)}</option>
              <option value="max">{tc(MODE_LABELS.max)}</option>
            </select>
            {messages.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={tc('Clear chat')}
                onClick={() => setMessages([])}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            )}
            <Button type="button" variant="ghost" size="icon-sm" aria-label={tc('Close')} onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Transcript */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.length === 0 ? (
            <div className="space-y-4 py-6">
              <div className="text-center space-y-1">
                <Sparkles className="size-6 mx-auto text-primary/70" />
                <p className="text-sm font-medium">{tc('Start chatting with {name}', { name: assistant.name })}</p>
                <p className="text-xs text-muted-foreground">
                  {tc('Pick a starter prompt below or type your own request. Internal system prompts stay protected on the server.')}
                </p>
              </div>
              {assistant.starterPrompts.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                    {tc('Starter prompts')}
                  </p>
                  <div className="grid gap-2">
                    {assistant.starterPrompts.map((prompt, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => submitText(prompt)}
                        className="rounded-xl border bg-muted/30 px-3.5 py-2.5 text-left text-xs hover:bg-muted transition-colors"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/60 border text-foreground'
                  }`}
                >
                  {msg.content}
                </div>
                {msg.role === 'assistant' && (msg.model || msg.routingMode) && (
                  <span className="text-[10px] text-muted-foreground px-1">
                    {msg.model ?? 'auto'}
                    {msg.routingMode ? ` · ${msg.routingMode}` : ''}
                  </span>
                )}
              </div>
            ))
          )}
          {sendMutation.isPending && (
            <div className="text-xs text-muted-foreground">{tc('Thinking…')}</div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t p-4 flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={tc('Ask this assistant anything…')}
            rows={2}
            className="min-h-10 max-h-32 resize-none text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitText(input);
              }
            }}
          />
          <Button
            type="button"
            size="default"
            disabled={!input.trim() || sendMutation.isPending}
            onClick={() => submitText(input)}
          >
            <Send className="size-3.5 mr-1" />
            {tc('Send')}
          </Button>
        </div>
      </div>
    </div>
  );
}
