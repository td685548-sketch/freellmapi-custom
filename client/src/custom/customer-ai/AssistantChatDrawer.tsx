import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  BookOpen,
  Check,
  Eye,
  GitBranch,
  MessageSquarePlus,
  PanelLeft,
  Pencil,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import {
  detectAssistantArtifacts,
  type CustomerAiAssistant,
  type DetectedAssistantArtifact,
  type KeyRoutingMode,
  type UserCustomAssistant,
} from '../../../../shared/customer-ai';
import { useCustomT } from '../i18n/use-custom-t';
import {
  deleteAssistantThreadApi,
  fetchAssistantThreadDetail,
  fetchAssistantThreads,
  patchAssistantThread,
  postBranchAssistantThread,
  streamAssistantChat,
} from './api';
import { ArtifactPreviewPanel } from './ArtifactPreviewPanel';
import { formatWorkspaceString, useWorkspaceStrings } from './strings';

export type WorkspaceAssistantTarget = CustomerAiAssistant | UserCustomAssistant;

interface ChatEntry {
  id?: number;
  messageIndex?: number;
  role: 'user' | 'assistant';
  content: string;
  model?: string | null;
  routingMode?: KeyRoutingMode | null;
  streaming?: boolean;
}

const MODE_LABELS: Record<KeyRoutingMode, string> = {
  default: 'Recommended',
  eco: 'Eco (Fast)',
  balanced: 'Balanced',
  max: 'Max Quality',
};

function getTargetRef(assistant: WorkspaceAssistantTarget): string {
  return 'assistantRef' in assistant ? assistant.assistantRef : assistant.slug;
}

function getStarterPrompts(assistant: WorkspaceAssistantTarget): string[] {
  return 'starterPrompts' in assistant ? assistant.starterPrompts : [];
}

function hasPersonalKnowledge(assistant: WorkspaceAssistantTarget): boolean {
  return 'knowledgeMarkdown' in assistant && Boolean(assistant.knowledgeMarkdown.trim());
}

export function AssistantChatDrawer({
  assistant,
  onClose,
}: {
  assistant: WorkspaceAssistantTarget | null;
  onClose: () => void;
}) {
  if (!assistant) return null;
  const refKey = getTargetRef(assistant);
  return <AssistantChatDrawerContent key={refKey} assistant={assistant} onClose={onClose} />;
}

function AssistantChatDrawerContent({
  assistant,
  onClose,
}: {
  assistant: WorkspaceAssistantTarget;
  onClose: () => void;
}) {
  const tc = useCustomT();
  const ws = useWorkspaceStrings();
  const queryClient = useQueryClient();
  const assistantRef = getTargetRef(assistant);
  const starterPrompts = getStarterPrompts(assistant);
  const knowledgeActive = hasPersonalKnowledge(assistant);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [routingMode, setRoutingMode] = useState<KeyRoutingMode>(
    assistant.recommendedRoutingMode === 'default' ? 'balanced' : assistant.recommendedRoutingMode,
  );

  const abortRef = useRef<AbortController | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      abortRef.current?.abort();
    };
  }, [onClose]);

  const { data: threadsData } = useQuery({
    queryKey: ['assistant-threads', assistantRef],
    queryFn: () => fetchAssistantThreads(assistantRef),
  });

  const threads = useMemo(
    () => (Array.isArray(threadsData?.threads) ? threadsData.threads : []),
    [threadsData],
  );

  // Collect all artifacts across current messages so the split-pane can switch between them
  const allArtifacts = useMemo<DetectedAssistantArtifact[]>(() => {
    const collected: DetectedAssistantArtifact[] = [];
    messages.forEach((msg, idx) => {
      if (msg.role === 'assistant' && msg.content) {
        collected.push(...detectAssistantArtifacts(msg.content, `m${idx}`));
      }
    });
    return collected;
  }, [messages]);

  const activeArtifact = useMemo(
    () => (selectedArtifactId ? allArtifacts.find(a => a.id === selectedArtifactId) ?? null : null),
    [allArtifacts, selectedArtifactId],
  );

  const selectThreadMutation = useMutation({
    mutationFn: (threadId: number) => fetchAssistantThreadDetail(threadId),
    onSuccess: ({ thread }) => {
      setActiveThreadId(thread.id);
      setRoutingMode(thread.routingMode === 'default' ? 'balanced' : thread.routingMode);
      setSelectedArtifactId(null);
      setMessages(
        thread.messages.map(m => ({
          id: m.id,
          messageIndex: m.messageIndex,
          role: m.role,
          content: m.content,
          model: m.model,
          routingMode: m.routingMode,
        })),
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const renameMutation = useMutation({
    mutationFn: ({ threadId, title }: { threadId: number; title: string }) =>
      patchAssistantThread(threadId, { title }),
    onSuccess: () => {
      setRenamingThreadId(null);
      setRenameDraft('');
      void queryClient.invalidateQueries({ queryKey: ['assistant-threads', assistantRef] });
      toast.success(ws.threadRenamedToast);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (threadId: number) => deleteAssistantThreadApi(threadId),
    onSuccess: (_res, deletedId) => {
      if (activeThreadId === deletedId) {
        setActiveThreadId(null);
        setMessages([]);
        setSelectedArtifactId(null);
      }
      void queryClient.invalidateQueries({ queryKey: ['assistant-threads', assistantRef] });
      toast.success(ws.threadDeletedToast);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const forkMutation = useMutation({
    mutationFn: ({ threadId, messageIndex }: { threadId: number; messageIndex: number }) =>
      postBranchAssistantThread(threadId, { fromMessageIndex: messageIndex }),
    onSuccess: ({ thread }, vars) => {
      setActiveThreadId(thread.id);
      setMessages(
        thread.messages.map(m => ({
          id: m.id,
          messageIndex: m.messageIndex,
          role: m.role,
          content: m.content,
          model: m.model,
          routingMode: m.routingMode,
        })),
      );
      void queryClient.invalidateQueries({ queryKey: ['assistant-threads', assistantRef] });
      toast.success(
        formatWorkspaceString(ws.threadForkedToast, { index: vars.messageIndex + 1 }),
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const startNewThread = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setActiveThreadId(null);
    setMessages([]);
    setSelectedArtifactId(null);
  };

  const stopStream = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setMessages(prev =>
      prev.map((m, idx) => (idx === prev.length - 1 && m.streaming ? { ...m, streaming: false } : m)),
    );
  };

  const submitText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    const userTurnIndex = messages.length;
    const assistantTurnIndex = messages.length + 1;

    setInput('');
    setIsStreaming(true);
    setMessages(prev => [
      ...prev,
      { role: 'user', content: trimmed, messageIndex: userTurnIndex },
      { role: 'assistant', content: '', routingMode, streaming: true, messageIndex: assistantTurnIndex },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await streamAssistantChat(
        {
          assistantRef,
          threadId: activeThreadId ?? undefined,
          createThread: activeThreadId === null,
          message: trimmed,
          routingMode,
        },
        {
          onMeta: meta => {
            if (meta.threadId) {
              setActiveThreadId(meta.threadId);
            }
          },
          onDelta: delta => {
            setMessages(prev => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last && last.role === 'assistant') {
                copy[copy.length - 1] = {
                  ...last,
                  content: last.content + delta,
                };
              }
              return copy;
            });
          },
        },
        controller.signal,
      );

      if (result.threadId) {
        setActiveThreadId(result.threadId);
      }

      setMessages(prev => {
        const copy = [...prev];
        const userSlot = copy.length - 2;
        const assistantSlot = copy.length - 1;
        if (userSlot >= 0 && copy[userSlot]?.role === 'user' && result.userMessage) {
          copy[userSlot] = {
            ...copy[userSlot]!,
            id: result.userMessage.id,
            messageIndex: result.userMessage.messageIndex,
          };
        }
        if (assistantSlot >= 0 && copy[assistantSlot]?.role === 'assistant') {
          const finalContent = result.reply || copy[assistantSlot]!.content;
          copy[assistantSlot] = {
            id: result.assistantMessage?.id,
            messageIndex: result.assistantMessage?.messageIndex ?? assistantTurnIndex,
            role: 'assistant',
            content: finalContent,
            model: result.model,
            routingMode: result.routingMode,
            streaming: false,
          };
          const detected = detectAssistantArtifacts(finalContent, `m${assistantSlot}`);
          if (detected.length > 0 && !selectedArtifactId) {
            setSelectedArtifactId(detected[0]!.id);
          }
        }
        return copy;
      });

      void queryClient.invalidateQueries({ queryKey: ['assistant-threads', assistantRef] });
      void queryClient.invalidateQueries({ queryKey: ['customer-ai-catalog'] });
      setTimeout(() => transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 40);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : tc('Assistant chat failed'));
      setMessages(prev => prev.filter(m => !(m.streaming && !m.content)));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={assistant.name}
        className={`flex h-[min(90vh,54rem)] w-full ${
          activeArtifact ? 'max-w-7xl' : 'max-w-5xl'
        } flex-col rounded-3xl border bg-card shadow-2xl overflow-hidden transition-all`}
        onClick={e => e.stopPropagation()}
      >
        {/* Top Workspace Header */}
        <div className="flex items-center justify-between gap-3 border-b px-4 sm:px-5 py-3.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={ws.toggleThreadsSidebar}
              onClick={() => setSidebarOpen(prev => !prev)}
            >
              <PanelLeft className="size-4" />
            </Button>

            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Bot className="size-4 text-primary shrink-0" />
                <h2 className="text-sm font-semibold truncate">{assistant.name}</h2>
                {knowledgeActive && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium">
                    <BookOpen className="size-3" />
                    {ws.PersonalKnowledgeActive}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground line-clamp-1">{assistant.description}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <select
              aria-label={tc('Routing mode')}
              value={routingMode}
              onChange={e => setRoutingMode(e.target.value as KeyRoutingMode)}
              className="h-8 rounded-lg border bg-background px-2 text-xs"
            >
              <option value="eco">{tc(MODE_LABELS.eco)}</option>
              <option value="balanced">{tc(MODE_LABELS.balanced)}</option>
              <option value="max">{tc(MODE_LABELS.max)}</option>
            </select>

            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={startNewThread}
            >
              <MessageSquarePlus className="size-3.5 mr-1" />
              {ws.newThread}
            </Button>

            <Button type="button" variant="ghost" size="icon-sm" aria-label={tc('Close')} onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Main 2-or-3 Pane Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden flex-col lg:flex-row">
          {/* Left Saved Threads Sidebar */}
          {sidebarOpen && (
            <div className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r bg-muted/20 flex flex-col max-h-44 lg:max-h-none">
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {ws.savedThreads}
                </span>
                <span className="text-[11px] text-muted-foreground">{threads.length}</span>
              </div>

              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {threads.length === 0 ? (
                  <p className="px-2 py-4 text-xs text-muted-foreground text-center">
                    {ws.noSavedThreads}
                  </p>
                ) : (
                  threads.map(thread => {
                    const isActive = thread.id === activeThreadId;
                    const isRenaming = renamingThreadId === thread.id;

                    return (
                      <div
                        key={thread.id}
                        className={`group rounded-xl px-2.5 py-2 text-xs transition-colors ${
                          isActive
                            ? 'bg-primary/10 text-foreground font-medium border border-primary/25'
                            : 'hover:bg-muted/70 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {isRenaming ? (
                          <form
                            className="flex items-center gap-1"
                            onSubmit={e => {
                              e.preventDefault();
                              if (renameDraft.trim()) {
                                renameMutation.mutate({ threadId: thread.id, title: renameDraft.trim() });
                              }
                            }}
                          >
                            <Input
                              value={renameDraft}
                              onChange={e => setRenameDraft(e.target.value)}
                              className="h-7 text-xs px-2"
                              autoFocus
                            />
                            <Button type="submit" variant="ghost" size="icon-sm" className="size-6">
                              <Check className="size-3" />
                            </Button>
                          </form>
                        ) : (
                          <div className="flex items-start justify-between gap-1.5">
                            <button
                              type="button"
                              onClick={() => selectThreadMutation.mutate(thread.id)}
                              className="flex-1 text-left min-w-0 space-y-0.5"
                            >
                              <div className="truncate">{thread.title}</div>
                              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <span>{thread.messageCount} msgs</span>
                                {thread.forkedFromMessageIndex !== null && (
                                  <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.2">
                                    <GitBranch className="size-2.5" />
                                    {formatWorkspaceString(ws.forkedBadge, {
                                      index: thread.forkedFromMessageIndex + 1,
                                    })}
                                  </span>
                                )}
                              </div>
                            </button>

                            <div className="flex items-center opacity-70 group-hover:opacity-100 shrink-0">
                              <button
                                type="button"
                                aria-label={ws.renameThread}
                                onClick={() => {
                                  setRenamingThreadId(thread.id);
                                  setRenameDraft(thread.title);
                                }}
                                className="p-1 rounded hover:bg-background text-muted-foreground hover:text-foreground"
                              >
                                <Pencil className="size-3" />
                              </button>
                              <button
                                type="button"
                                aria-label={ws.deleteThread}
                                onClick={() => deleteMutation.mutate(thread.id)}
                                className="p-1 rounded hover:bg-background text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="size-3" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Center Chat Transcript & Composer */}
          <div className="flex flex-1 flex-col min-w-0 min-h-0">
            <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
              {messages.length === 0 ? (
                <div className="space-y-4 py-8 max-w-xl mx-auto">
                  <div className="text-center space-y-1.5">
                    <Sparkles className="size-6 mx-auto text-primary/70" />
                    <p className="text-sm font-medium">
                      {tc('Start chatting with {name}', { name: assistant.name })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {tc('Pick a starter prompt below or type your own request. Internal system prompts stay protected on the server.')}
                    </p>
                  </div>
                  {starterPrompts.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                        {tc('Starter prompts')}
                      </p>
                      <div className="grid gap-2">
                        {starterPrompts.map((prompt, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => void submitText(prompt)}
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
                messages.map((msg, idx) => {
                  const turnArtifacts =
                    msg.role === 'assistant' && msg.content
                      ? detectAssistantArtifacts(msg.content, `m${idx}`)
                      : [];
                  const canFork = activeThreadId !== null && !isStreaming && !msg.streaming;
                  const forkIdx = msg.messageIndex ?? idx;

                  return (
                    <div
                      key={msg.id ?? `turn-${idx}`}
                      className={`flex flex-col gap-1.5 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                    >
                      <div
                        className={`max-w-[90%] rounded-2xl px-4 py-3 text-xs leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-primary text-primary-foreground whitespace-pre-wrap'
                            : 'bg-muted/50 border text-foreground space-y-2 overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-background [&_pre]:border [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:font-mono'
                        }`}
                      >
                        {msg.role === 'user' ? (
                          msg.content
                        ) : msg.content ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                        ) : (
                          <span className="text-muted-foreground italic">{ws.streamingReply}</span>
                        )}
                      </div>

                      {/* Turn Metadata + Fork + Artifact Preview Buttons */}
                      <div className="flex flex-wrap items-center gap-2 px-1">
                        {msg.role === 'assistant' && (msg.model || msg.routingMode) && (
                          <span className="text-[10px] text-muted-foreground">
                            {msg.model ?? 'auto'}
                            {msg.routingMode ? ` · ${msg.routingMode}` : ''}
                          </span>
                        )}

                        {canFork && (
                          <button
                            type="button"
                            disabled={forkMutation.isPending}
                            onClick={() =>
                              forkMutation.mutate({
                                threadId: activeThreadId,
                                messageIndex: forkIdx,
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <GitBranch className="size-2.5" />
                            {ws.forkThread}
                          </button>
                        )}

                        {turnArtifacts.map(art => (
                          <button
                            key={art.id}
                            type="button"
                            onClick={() => setSelectedArtifactId(art.id)}
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                              selectedArtifactId === art.id
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-primary/10 text-primary border-primary/20 hover:bg-primary/15'
                            }`}
                          >
                            <Eye className="size-2.5" />
                            {ws.previewArtifact}: {art.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={transcriptEndRef} />
            </div>

            {/* Composer */}
            <div className="border-t p-3.5 sm:p-4 flex items-end gap-2 bg-card">
              <Textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder={tc('Ask this assistant anything…')}
                rows={2}
                className="min-h-10 max-h-32 resize-none text-xs"
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submitText(input);
                  }
                }}
              />
              {isStreaming ? (
                <Button type="button" variant="outline" size="default" onClick={stopStream}>
                  <Square className="size-3.5 mr-1" />
                  {ws.stopGenerating}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="default"
                  disabled={!input.trim()}
                  onClick={() => void submitText(input)}
                >
                  <Send className="size-3.5 mr-1" />
                  {tc('Send')}
                </Button>
              )}
            </div>
          </div>

          {/* Right Split-Pane Live Artifact Preview */}
          {activeArtifact && (
            <div className="w-full lg:w-[44%] shrink-0 h-72 lg:h-full">
              <ArtifactPreviewPanel
                artifacts={allArtifacts}
                activeArtifactId={activeArtifact.id}
                onSelectArtifact={setSelectedArtifactId}
                onClose={() => setSelectedArtifactId(null)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
