import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eraser,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelLeft,
  PanelLeftClose,
  Paperclip,
  Plus,
  RefreshCw,
  Send,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  X,
  AlertCircle,
} from 'lucide-react';
import { usePlaygroundStrings } from '../playground-strings';
import { PlaygroundMessageContent } from '../PlaygroundMessage';
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

async function optimizeImageFile(file: File): Promise<{ id: string; name: string; url: string }> {
  // If file is GIF or already small (<= 800KB), keep as-is to avoid re-encoding
  if (file.type === 'image/gif' || file.size <= 800_000) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          id: crypto.randomUUID(),
          name: file.name || 'image.png',
          url: reader.result as string,
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Otherwise downscale and compress via canvas
  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX_DIM = 1920;
      let width = img.width;
      let height = img.height;

      if (width > MAX_DIM || height > MAX_DIM) {
        if (width > height) {
          height = Math.round((height * MAX_DIM) / width);
          width = MAX_DIM;
        } else {
          width = Math.round((width * MAX_DIM) / height);
          height = MAX_DIM;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        const compressedUrl = canvas.toDataURL('image/jpeg', 0.85);
        resolve({
          id: crypto.randomUUID(),
          name: file.name ? file.name.replace(/\.[^.]+$/, '.jpg') : 'pasted-image.jpg',
          url: compressedUrl,
        });
        return;
      }

      const reader = new FileReader();
      reader.onload = () =>
        resolve({
          id: crypto.randomUUID(),
          name: file.name || 'image.png',
          url: reader.result as string,
        });
      reader.readAsDataURL(file);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      const reader = new FileReader();
      reader.onload = () =>
        resolve({
          id: crypto.randomUUID(),
          name: file.name || 'image.png',
          url: reader.result as string,
        });
      reader.readAsDataURL(file);
    };
    img.src = objectUrl;
  });
}

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

  // Sidebar toggle state (collapsible to give full width to chat)
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('x_playground_sidebar');
      return saved !== 'false';
    } catch {
      return true;
    }
  });

  const toggleSidebar = useCallback(() => {
    setIsSidebarOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('x_playground_sidebar', String(next));
      } catch {
        // ignore storage error
      }
      return next;
    });
  }, []);

  // Full-width mode state (stretches chat container horizontally for large displays)
  const [isFullWidth, setIsFullWidth] = useState(() => {
    try {
      return localStorage.getItem('x_playground_fullwidth') === '1';
    } catch {
      return false;
    }
  });

  const toggleFullWidth = useCallback(() => {
    setIsFullWidth((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('x_playground_fullwidth', next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // Expandable input box state ("khung chat dài hơn" / larger prompt workspace)
  const [isInputExpanded, setIsInputExpanded] = useState(false);
  const toggleInputExpanded = useCallback(() => {
    setIsInputExpanded((prev) => !prev);
  }, []);

  // Settings open state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Clear current conversation messages
  const handleClearCurrentChat = useCallback(() => {
    if (activeChat.messages.length === 0) return;
    if (!window.confirm(s.clearConfirm)) return;
    setChats((prev) =>
      prev.map((c) => (c.id === activeChat.id ? { ...c, messages: [] } : c))
    );
  }, [activeChat.id, activeChat.messages.length, s.clearConfirm]);

  // Textarea dynamic height adjustment
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (isInputExpanded) {
      el.style.height = '180px';
      return;
    }
    el.style.height = 'auto';
    const newHeight = Math.min(Math.max(el.scrollHeight, 60), 320);
    el.style.height = `${newHeight}px`;
  }, [isInputExpanded]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [inputText, isInputExpanded, adjustTextareaHeight]);

  // Settings
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxTokens, setMaxTokens] = useState<number>(2048);

  // Streaming state
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);

  // Auto-scroll inside chat container
  const scrollToBottom = useCallback((force = false) => {
    const el = messagesContainerRef.current;
    if (!el) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (force || isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const threshold = 60;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    isNearBottomRef.current = nearBottom;
    setIsNearBottom(nearBottom);
  }, []);

  useEffect(() => {
    scrollToBottom(false);
  }, [activeChat.messages, isStreaming, scrollToBottom]);

  useEffect(() => {
    setIsNearBottom(true);
    isNearBottomRef.current = true;
    scrollToBottom(true);
  }, [activeChat.id, scrollToBottom]);

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
    setIsNearBottom(true);
    isNearBottomRef.current = true;
    setTimeout(() => scrollToBottom(true), 0);
    setAttachments([]);
  };

  const handleNewChat = () => {
    if (isStreaming) handleStopStream();
    const created = newChat();
    setChats((prev) => [created, ...prev.slice(0, 19)]);
    setActiveChatId(created.id);
    setInputText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setAttachments([]);
    setInputError(null);
    setStreamError(null);
    setIsNearBottom(true);
    isNearBottomRef.current = true;
    setTimeout(() => scrollToBottom(true), 0);
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

  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Unified image processor supporting paperclip pick, clipboard paste (Ctrl+V) and drag-and-drop
  const processFiles = useCallback(
    async (files: File[]) => {
      setInputError(null);
      if (!files.length) return;

      if (attachments.length + files.length > 4) {
        setInputError(s.imageError);
        return;
      }

      const validFiles = files.filter(
        (f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.name)
      );

      if (validFiles.length === 0) {
        setInputError(s.imageError);
        return;
      }

      try {
        const optimized = await Promise.all(validFiles.map(optimizeImageFile));
        setAttachments((prev) => [...prev, ...optimized].slice(0, 4));
      } catch {
        setInputError(s.imageError);
      }
    },
    [attachments.length, s.imageError]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      void processFiles(files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      void processFiles(files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length > 0) {
      void processFiles(files);
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
    setIsNearBottom(true);
    isNearBottomRef.current = true;
    setTimeout(() => scrollToBottom(true), 0);

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
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setAttachments([]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Prepare API messages
    const requestMessages: PlaygroundRequest['messages'] = [];
    if (systemPrompt.trim()) {
      requestMessages.push({ role: 'system', content: systemPrompt.trim() });
    }

    // Helper to format multimodal content parts safely without empty text blocks
    const buildParts = (text: string, images?: ChatImage[]): PlaygroundContent => {
      const parts: PlaygroundContent = [];
      const trimmed = text.trim();
      if (trimmed) {
        parts.push({ type: 'text', text: trimmed });
      }
      if (images && images.length > 0) {
        for (const img of images) {
          parts.push({
            type: 'image_url' as const,
            image_url: { url: img.url },
          });
        }
      }
      // If user submitted an image without prompt, add a concise default instruction
      // to avoid 400 errors on upstream vision models requiring non-empty text.
      if (parts.length > 0 && !parts.some((p) => p.type === 'text')) {
        parts.unshift({ type: 'text', text: 'Describe or analyze this image.' });
      }
      return parts;
    };

    for (const msg of activeChat.messages) {
      if (msg.images && msg.images.length > 0) {
        requestMessages.push({ role: msg.role, content: buildParts(msg.content, msg.images) });
      } else {
        requestMessages.push({ role: msg.role, content: msg.content });
      }
    }

    // Add current user turn
    if (userTurn.images && userTurn.images.length > 0) {
      requestMessages.push({ role: 'user', content: buildParts(userTurn.content, userTurn.images) });
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
    <div className="x-page x-playground-page">
      {/* Slim Header Bar */}
      <div className="x-page-heading x-playground-heading flex items-center justify-between py-1 px-1 mb-1 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="size-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary flex-shrink-0">
            <MessageSquare size={15} />
          </div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-sm font-semibold tracking-tight text-foreground m-0 leading-tight">
              {s.title}
            </h1>
            <p className="text-[11px] text-muted-foreground m-0 hidden sm:inline">
              {s.help}
            </p>
          </div>
        </div>
      </div>

      {/* Gateway Disabled Banner */}
      {catalog && !catalog.enabled && (
        <div className="x-chat-notice flex items-center justify-between flex-shrink-0" role="alert">
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
      <div className={`x-basic-chat ${!isSidebarOpen ? 'sidebar-collapsed' : ''}`}>
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
          {/* Top Toolbar: Model Selector, Width Toggle & Actions */}
          <div className="x-chat-toolbar flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-card/60 backdrop-blur-sm flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={toggleSidebar}
                className="x-sidebar-toggle-btn"
                title={isSidebarOpen ? s.collapseSidebar : s.expandSidebar}
                aria-label={isSidebarOpen ? s.collapseSidebar : s.expandSidebar}
              >
                {isSidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeft size={15} />}
              </button>

              <span className="text-xs font-medium text-foreground truncate max-w-[140px] sm:max-w-[200px] hidden md:inline">
                {activeChat.title || s.newChat}
              </span>
            </div>

            {/* Model Selector */}
            <div className="flex items-center gap-1.5 flex-1 max-w-md mx-2 min-w-0">
              <label className="flex-1 min-w-0 flex items-center gap-1.5 bg-background border border-border rounded-lg px-2.5 py-1 focus-within:border-primary shadow-xs">
                <Sparkles size={14} className="text-primary flex-shrink-0" />
                <span className="sr-only">{s.model}</span>
                <select
                  value={activeChat.model || 'auto'}
                  onChange={(e) => handleModelChange(e.target.value)}
                  disabled={isStreaming || isCatalogLoading}
                  className="w-full text-xs bg-transparent border-0 outline-none p-0 cursor-pointer"
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
                className="x-icon-button hover:text-primary transition flex-shrink-0"
                onClick={() => void refetchModels()}
                disabled={isCatalogLoading || isStreaming}
                title={s.refresh}
              >
                <RefreshCw size={13} className={isCatalogLoading ? 'animate-spin' : ''} />
                <span className="sr-only">{s.refresh}</span>
              </button>
            </div>

            {/* Right Action Controls */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                type="button"
                onClick={toggleFullWidth}
                className={`x-icon-button ${isFullWidth ? 'text-primary bg-primary/10' : ''}`}
                title={isFullWidth ? s.standardWidth : s.fullWidth}
                aria-label={isFullWidth ? s.standardWidth : s.fullWidth}
              >
                {isFullWidth ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>

              <button
                type="button"
                onClick={() => setIsSettingsOpen((prev) => !prev)}
                className={`x-icon-button ${isSettingsOpen ? 'text-primary bg-primary/10' : ''}`}
                title={s.settings}
                aria-label={s.settings}
              >
                <Sliders size={14} />
              </button>

              {activeChat.messages.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearCurrentChat}
                  className="x-icon-button hover:text-destructive"
                  title={s.clearChat}
                  aria-label={s.clearChat}
                >
                  <Eraser size={14} />
                </button>
              )}

              <button
                type="button"
                onClick={handleNewChat}
                disabled={isStreaming}
                className="x-button x-primary py-1 px-2.5 text-xs inline-flex items-center gap-1 ml-1"
                title={s.newChat}
              >
                <Plus size={13} />
                <span className="hidden sm:inline">{s.newChat}</span>
              </button>
            </div>
          </div>

          {/* Collapsible Chat Settings */}
          <details
            open={isSettingsOpen}
            onToggle={(e) => setIsSettingsOpen(e.currentTarget.open)}
            className="x-chat-settings px-4 py-2.5 bg-muted/20 border-b border-border text-xs flex-shrink-0 transition-all"
          >
            <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 py-0.5">
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
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            className="x-chat-messages flex-1 overflow-y-auto space-y-4 my-0 px-2 py-4"
          >
            <div className={`x-chat-thread ${isFullWidth ? 'x-thread-full' : 'x-thread-standard'}`}>
              {activeChat.messages.length === 0 ? (
                <div className="x-chat-welcome">
                  <div className="size-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mx-auto mb-3 shadow-xs">
                    <MessageSquare size={24} />
                  </div>
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
                      <div className="flex items-center gap-2">
                        {msg.role === 'assistant' ? (
                          <>
                            <div className="size-5 rounded-md bg-primary/10 text-primary flex items-center justify-center font-bold text-[10px]">
                              AI
                            </div>
                            <span className="font-semibold text-foreground text-xs">
                              {s.assistant}
                            </span>
                          </>
                        ) : (
                          <span className="font-semibold text-primary text-xs">
                            {s.you}
                          </span>
                        )}
                      </div>

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

                    {msg.role === 'user' ? (
                      <div className="x-user-text font-sans text-sm whitespace-pre-wrap leading-relaxed">
                        {msg.content}
                      </div>
                    ) : (
                      <PlaygroundMessageContent
                        content={msg.content}
                        isGenerating={msg.meta === s.generating}
                        generatingLabel={s.generating}
                      />
                    )}

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

                    {msg.meta && msg.meta !== s.generating && (
                      <div className="mt-2 pt-2 border-t border-border/40 text-[11px] text-muted-foreground flex items-center gap-2">
                        <span>{msg.meta}</span>
                      </div>
                    )}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Error Banner */}
          {(streamError || inputError) && (
            <div className="x-error my-2 mx-4 p-2.5 rounded-lg text-xs flex-shrink-0" role="alert">
              {streamError || inputError}
            </div>
          )}

          {/* Floating Scroll to bottom button */}
          {!isNearBottom && activeChat.messages.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setIsNearBottom(true);
                isNearBottomRef.current = true;
                scrollToBottom(true);
              }}
              className="x-scroll-bottom-btn"
              title="Cuộn xuống tin nhắn mới nhất"
              aria-label="Scroll to bottom"
            >
              <ChevronDown size={16} />
            </button>
          )}

          {/* Composer & Input Area */}
          <div className={`x-composer-wrapper ${isFullWidth ? 'x-thread-full' : 'x-thread-standard'}`}>
            <div
              className={`x-chat-composer border rounded-2xl overflow-hidden bg-background transition-all shadow-md ${
                isDraggingOver ? 'border-primary ring-2 ring-primary/30 bg-primary/5' : 'border-border'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
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
                ref={textareaRef}
                rows={3}
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  adjustTextareaHeight();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                onPaste={(e) => {
                  handlePaste(e);
                  setTimeout(adjustTextareaHeight, 0);
                }}
                placeholder={s.placeholder}
                disabled={isStreaming}
                className="w-full p-3.5 border-0 bg-transparent text-sm focus:outline-hidden resize-none"
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

                  <button
                    type="button"
                    onClick={toggleInputExpanded}
                    className={`p-1.5 rounded-lg border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition inline-flex items-center gap-1 text-xs ${
                      isInputExpanded ? 'text-primary border-primary/40 bg-primary/5' : ''
                    }`}
                    title={isInputExpanded ? s.collapseInput : s.expandInput}
                    aria-label={isInputExpanded ? s.collapseInput : s.expandInput}
                  >
                    {isInputExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                    <span className="hidden sm:inline">
                      {isInputExpanded ? s.collapseInput : s.expandInput}
                    </span>
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
          </div>
        </main>
      </div>
    </div>
  );
}
