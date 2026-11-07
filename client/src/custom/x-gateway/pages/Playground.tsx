import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Check,
  Copy,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  X,
  AlertCircle,
  Sliders,
} from 'lucide-react';
import { usePlaygroundStrings } from '../playground-strings';
import {
  loadPlaygroundModels,
  streamPlayground,
  type PlaygroundRequest,
  type PlaygroundContent,
} from '../playground-api';
import {
  newChat,
  loadChats,
  saveChats,
  type ChatSession,
  type ChatTurn,
  type ChatImage,
} from '../playground-state';
import { useUserSession } from '../../use-session';
import { useSessionRevision } from '../../session-state';
import '../playground.css';

export default function Playground() {
  const s = usePlaygroundStrings();
  const session = useUserSession();
  const revision = useSessionRevision();
  const userId = session.session?.userId ?? 0;

  // Models catalog query
  const {
    data: catalog,
    isLoading: isCatalogLoading,
    refetch: refetchModels,
  } = useQuery({
    queryKey: ['x-gateway-playground-models', revision],
    queryFn: ({ signal }) => loadPlaygroundModels(signal),
    staleTime: 60_000,
  });

  // Chat sessions state
  const [chats, setChats] = useState<ChatSession[]>(() => {
    const loaded = loadChats(userId);
    return loaded.length > 0 ? loaded : [newChat()];
  });
  const [activeChatId, setActiveChatId] = useState<string>(() => chats[0]?.id ?? '');

  // Active chat
  const activeChat = useMemo(() => {
    return chats.find((c) => c.id === activeChatId) || chats[0] || newChat();
  }, [chats, activeChatId]);

  // Input & attachments state
  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState<ChatImage[]>([]);
  const [inputError, setInputError] = useState<string | null>(null);

  // Settings
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxTokens, setMaxTokens] = useState<number>(2048);

  // Streaming state
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);

  // Auto-scroll to bottom of chat
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [activeChat.messages, isStreaming, scrollToBottom]);

  // Persist chats to localStorage whenever they change
  useEffect(() => {
    if (userId) {
      saveChats(userId, chats);
    }
  }, [chats, userId]);

  // Model selection grouped by provider / combos
  const groupedModels = useMemo(() => {
    if (!catalog?.models) return {};
    const groups: Record<string, typeof catalog.models> = {};
    for (const m of catalog.models) {
      const groupName = m.provider || 'Other';
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(m);
    }
    return groups;
  }, [catalog]);

  const handleSelectChat = (id: string) => {
    if (isStreaming) handleStopStream();
    setActiveChatId(id);
    setInputError(null);
    setStreamError(null);
    setAttachments([]);
  };

  const handleNewChat = () => {
    if (isStreaming) handleStopStream();
    const created = newChat();
    setChats((prev) => [created, ...prev.slice(0, 19)]);
    setActiveChatId(created.id);
    setInputText('');
    setAttachments([]);
    setInputError(null);
    setStreamError(null);
  };

  const handleDeleteChat = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(s.deleteConfirm)) return;
    if (isStreaming && activeChatId === id) handleStopStream();

    const remaining = chats.filter((c) => c.id !== id);
    if (remaining.length === 0) {
      const fresh = newChat();
      setChats([fresh]);
      setActiveChatId(fresh.id);
    } else {
      setChats(remaining);
      if (activeChatId === id) {
        setActiveChatId(remaining[0]!.id);
      }
    }
  };

  const handleModelChange = (modelId: string) => {
    setChats((prev) =>
      prev.map((c) => (c.id === activeChatId ? { ...c, model: modelId, updatedAt: Date.now() } : c))
    );
  };

  // Image attachment handler (max 4 images, <= 1MB each, standard formats)
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputError(null);
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    if (attachments.length + files.length > 4) {
      setInputError(s.imageError);
      return;
    }

    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    for (const file of files) {
      if (!validTypes.includes(file.type) || file.size > 1_048_576) {
        setInputError(s.imageError);
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        const url = event.target?.result as string;
        if (url) {
          setAttachments((prev) => [
            ...prev,
            { id: crypto.randomUUID(), name: file.name, url },
          ]);
        }
      };
      reader.readAsDataURL(file);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleStopStream = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if ((!text && attachments.length === 0) || isStreaming) return;
    if (activeChat.messages.length >= 98) {
      setInputError(s.limit);
      return;
    }

    setInputError(null);
    setStreamError(null);

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      images: attachments.length > 0 ? [...attachments] : undefined,
    };

    const assistantTurnId = crypto.randomUUID();
    const placeholderAssistant: ChatTurn = {
      id: assistantTurnId,
      role: 'assistant',
      content: '',
      meta: s.generating,
    };

    const updatedMessages = [...activeChat.messages, userTurn, placeholderAssistant];
    const newTitle = activeChat.title || text.slice(0, 30) || 'New conversation';

    setChats((prev) =>
      prev.map((c) =>
        c.id === activeChat.id
          ? {
              ...c,
              title: newTitle,
              messages: updatedMessages,
              updatedAt: Date.now(),
            }
          : c
      )
    );

    setInputText('');
    setAttachments([]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Prepare API messages
    const requestMessages: PlaygroundRequest['messages'] = [];
    if (systemPrompt.trim()) {
      requestMessages.push({ role: 'system', content: systemPrompt.trim() });
    }

    for (const msg of activeChat.messages) {
      if (msg.images && msg.images.length > 0) {
        const parts: PlaygroundContent = [
          { type: 'text', text: msg.content },
          ...msg.images.map((img) => ({
            type: 'image_url' as const,
            image_url: { url: img.url },
          })),
        ];
        requestMessages.push({ role: msg.role, content: parts });
      } else {
        requestMessages.push({ role: msg.role, content: msg.content });
      }
    }

    // Add current user turn
    if (userTurn.images && userTurn.images.length > 0) {
      const parts: PlaygroundContent = [
        { type: 'text', text: userTurn.content },
        ...userTurn.images.map((img) => ({
          type: 'image_url' as const,
          image_url: { url: img.url },
        })),
      ];
      requestMessages.push({ role: 'user', content: parts });
    } else {
      requestMessages.push({ role: 'user', content: userTurn.content });
    }

    const payload: PlaygroundRequest = {
      model: activeChat.model || 'auto',
      messages: requestMessages,
      temperature,
      max_tokens: maxTokens,
    };

    let accumulatedContent = '';

    try {
      const result = await streamPlayground(
        payload,
        controller.signal,
        (delta) => {
          accumulatedContent += delta;
          setChats((prev) =>
            prev.map((c) => {
              if (c.id !== activeChat.id) return c;
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === assistantTurnId ? { ...m, content: accumulatedContent } : m
                ),
              };
            })
          );
        }
      );

      const usageTokens = result.usage
        ? (result.usage.prompt_tokens ?? 0) + (result.usage.completion_tokens ?? 0)
        : null;
      const metaString = `${result.route} · ${result.latencyMs} ms${
        usageTokens !== null ? ` · ${usageTokens} ${s.tokens}` : ''
      }`;

      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== activeChat.id) return c;
          return {
            ...c,
            messages: c.messages.map((m) =>
              m.id === assistantTurnId
                ? { ...m, content: accumulatedContent, meta: metaString }
                : m
            ),
          };
        })
      );
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Stream manually stopped by user
        setChats((prev) =>
          prev.map((c) => {
            if (c.id !== activeChat.id) return c;
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantTurnId ? { ...m, meta: 'Stopped' } : m
              ),
            };
          })
        );
      } else {
        const errorMsg = err instanceof Error ? err.message : s.failed;
        setStreamError(errorMsg);
        setChats((prev) =>
          prev.map((c) => {
            if (c.id !== activeChat.id) return c;
            return {
              ...c,
              messages: c.messages.filter((m) => m.id !== assistantTurnId),
            };
          })
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleCopyText = (text: string, turnId: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedTurnId(turnId);
    setTimeout(() => {
      setCopiedTurnId((curr) => (curr === turnId ? null : curr));
    }, 2000);
  };

  return (
    <div className="x-page space-y-4 max-w-6xl mx-auto pb-8">
      {/* Page Heading */}
      <div className="x-page-heading">
        <div>
          <h1>{s.title}</h1>
          <p>{s.help}</p>
        </div>
        <span className="x-heading-icon">
          <MessageSquare size={28} />
        </span>
      </div>

      {/* Gateway Disabled Banner */}
      {catalog && !catalog.enabled && (
        <div className="x-chat-notice flex items-center justify-between" role="alert">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} />
            <span>{s.disabled}</span>
          </div>
          <Link to="/x/endpoint" className="text-xs font-semibold underline">
            {s.endpoint}
          </Link>
        </div>
      )}

      {/* Main 2-Column Playground Layout */}
      <div className="x-basic-chat">
        {/* Left Column: Conversations History */}
        <aside className="x-panel x-chat-history">
          <button
            className="x-button x-primary w-full justify-center"
            onClick={handleNewChat}
            disabled={isStreaming}
          >
            <Plus size={15} />
            <span>{s.newChat}</span>
          </button>

          <h2>{s.history}</h2>

          <nav aria-label={s.history}>
            {chats.map((chat) => (
              <div
                key={chat.id}
                className={`group flex items-center justify-between rounded-lg px-2.5 py-1.5 transition ${
                  chat.id === activeChat.id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted/60 text-foreground'
                }`}
              >
                <button
                  className="flex-1 text-left text-xs truncate bg-transparent border-0 cursor-pointer p-0"
                  onClick={() => handleSelectChat(chat.id)}
                  title={chat.title || s.newChat}
                >
                  {chat.title || s.newChat}
                </button>
                <button
                  className="opacity-0 group-hover:opacity-100 hover:text-destructive transition p-1 bg-transparent border-0 cursor-pointer"
                  onClick={(e) => handleDeleteChat(chat.id, e)}
                  title={s.deleteChat}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </nav>

          <p className="x-caption text-[11px] text-muted-foreground mt-auto">{s.local}</p>
        </aside>

        {/* Right Column: Chat Workspace */}
        <main className="x-panel x-chat-workspace flex flex-col">
          {/* Top Toolbar: Model Selector & Actions */}
          <div className="x-chat-toolbar flex items-end gap-3 pb-3 border-b border-border">
            <label className="flex-1">
              <span className="font-medium text-xs text-foreground mb-1 block">{s.model}</span>
              <select
                value={activeChat.model || 'auto'}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={isStreaming || isCatalogLoading}
                className="w-full text-xs"
              >
                <option value="auto">auto (Gateway Auto Routing)</option>
                {Object.entries(groupedModels).map(([group, models]) => (
                  <optgroup key={group} label={group}>
                    {models
                      .filter((m) => m.id !== 'auto')
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.id})
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>

            <button
              className="x-button"
              onClick={() => void refetchModels()}
              disabled={isCatalogLoading || isStreaming}
              title={s.refresh}
            >
              <RefreshCw size={14} className={isCatalogLoading ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">{s.refresh}</span>
            </button>
          </div>

          {/* Collapsible Chat Settings */}
          <details className="x-chat-settings mt-2 mb-2 text-xs">
            <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 py-1">
              <Sliders size={13} />
              <span>{s.settings}</span>
            </summary>
            <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3">
              <label className="sm:col-span-2">
                <span className="block mb-1 text-muted-foreground">{s.system}</span>
                <input
                  type="text"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="You are a helpful coding assistant..."
                  className="w-full text-xs"
                />
              </label>

              <label>
                <span className="block mb-1 text-muted-foreground">
                  {s.temperature}: {temperature}
                </span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full"
                />
              </label>

              <label>
                <span className="block mb-1 text-muted-foreground">{s.maxTokens}</span>
                <input
                  type="number"
                  min="1"
                  max="32768"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(parseInt(e.target.value, 10) || 2048)}
                  className="w-full text-xs"
                />
              </label>
            </fieldset>
          </details>

          {/* Messages Scroll Area */}
          <div className="x-chat-messages flex-1 overflow-y-auto space-y-4 my-2 pr-1">
            {activeChat.messages.length === 0 ? (
              <div className="x-chat-welcome">
                <MessageSquare size={36} />
                <h2>{s.empty}</h2>
                <p>{s.emptyHelp}</p>
              </div>
            ) : (
              activeChat.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`x-basic-turn ${
                    msg.role === 'user' ? 'x-basic-user' : 'x-basic-assistant'
                  }`}
                >
                  <header>
                    <span className="font-semibold">
                      {msg.role === 'user' ? s.you : s.assistant}
                    </span>
                    {msg.role === 'assistant' && msg.content && (
                      <button
                        className="x-icon-button hover:text-primary transition"
                        onClick={() => handleCopyText(msg.content, msg.id)}
                        title={s.copy}
                      >
                        {copiedTurnId === msg.id ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    )}
                  </header>

                  <pre className="x-user-text font-sans text-sm whitespace-pre-wrap leading-relaxed">
                    {msg.content || (msg.meta === s.generating ? (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <span className="size-2 bg-primary rounded-full animate-ping" />
                        {s.generating}
                      </span>
                    ) : (
                      ''
                    ))}
                  </pre>

                  {/* Render attached user images */}
                  {msg.images && msg.images.length > 0 && (
                    <div className="flex gap-2 mt-2 flex-wrap">
                      {msg.images.map((img) => (
                        <img
                          key={img.id}
                          src={img.url}
                          alt={img.name}
                          className="x-chat-image object-cover rounded-md max-h-36 border border-border"
                        />
                      ))}
                    </div>
                  )}

                  {msg.meta && msg.meta !== s.generating && <small>{msg.meta}</small>}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Error Banner */}
          {(streamError || inputError) && (
            <div className="x-error my-2 p-2.5 rounded-lg text-xs" role="alert">
              {streamError || inputError}
            </div>
          )}

          {/* Composer & Input Area */}
          <div className="x-chat-composer mt-2 border border-border rounded-xl overflow-hidden bg-background">
            {/* Attachment Previews */}
            {attachments.length > 0 && (
              <div className="x-chat-attachments flex gap-2 p-2 border-b border-border flex-wrap bg-muted/20">
                {attachments.map((att) => (
                  <div key={att.id} className="relative group">
                    <img
                      src={att.url}
                      alt={att.name}
                      className="size-16 object-cover rounded-md border border-border"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveAttachment(att.id)}
                      className="absolute -top-1.5 -right-1.5 size-5 bg-background border border-border rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive shadow-xs"
                      title={s.remove}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              rows={3}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={s.placeholder}
              disabled={isStreaming}
              className="w-full p-3 border-0 bg-transparent text-sm focus:outline-hidden resize-none"
            />

            <div className="x-chat-composer-actions flex items-center justify-between p-2.5 border-t border-border bg-muted/10">
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming || attachments.length >= 4}
                  className="p-1.5 rounded-lg border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition inline-flex items-center gap-1 text-xs"
                  title={s.attach}
                >
                  <Paperclip size={14} />
                  <span className="hidden sm:inline">{s.attach}</span>
                </button>
                <small className="text-[11px] text-muted-foreground">{s.shortcut}</small>
              </div>

              <div className="flex items-center gap-2">
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={handleStopStream}
                    className="x-button text-xs py-1.5 px-3 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    <Square size={13} />
                    <span>{s.stop}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={!inputText.trim() && attachments.length === 0}
                    className="x-button x-primary text-xs py-1.5 px-4 font-medium"
                  >
                    <Send size={13} />
                    <span>{s.send}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
