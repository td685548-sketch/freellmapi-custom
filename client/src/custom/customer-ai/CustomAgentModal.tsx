import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Sparkles, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';
import {
  ASSISTANT_CATEGORIES,
  MAX_USER_ASSISTANT_KNOWLEDGE_BYTES,
  MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS,
  type AssistantCategory,
  type KeyRoutingMode,
  type UserCustomAssistant,
} from '../../../../shared/customer-ai';
import { useCustomT } from '../i18n/use-custom-t';
import {
  patchUpdateUserCustomAssistant,
  postCreateUserCustomAssistant,
} from './api';
import { formatWorkspaceString, useWorkspaceStrings } from './strings';

const CATEGORY_LABELS: Record<AssistantCategory, string> = {
  coding: 'Coding',
  writing: 'Writing',
  data: 'Data & SQL',
  productivity: 'Productivity',
  general: 'General',
};

export function CustomAgentModal({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: UserCustomAssistant | null;
  onClose: () => void;
  onSaved?: (assistant: UserCustomAssistant) => void;
}) {
  if (!open) return null;
  return (
    <CustomAgentModalContent
      key={editing ? `edit-${editing.id}` : 'create-new'}
      editing={editing}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function CustomAgentModalContent({
  editing,
  onClose,
  onSaved,
}: {
  editing: UserCustomAssistant | null;
  onClose: () => void;
  onSaved?: (assistant: UserCustomAssistant) => void;
}) {
  const tc = useCustomT();
  const ws = useWorkspaceStrings();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState(editing?.name ?? '');
  const [slug, setSlug] = useState(editing?.slug ?? '');
  const [category, setCategory] = useState<AssistantCategory>(editing?.category ?? 'coding');
  const [routingMode, setRoutingMode] = useState<KeyRoutingMode>(
    editing?.recommendedRoutingMode ?? 'balanced',
  );
  const [description, setDescription] = useState(editing?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt ?? '');
  const [knowledgeMarkdown, setKnowledgeMarkdown] = useState(editing?.knowledgeMarkdown ?? '');

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const knowledgeBytes = useMemo(
    () => new TextEncoder().encode(knowledgeMarkdown).length,
    [knowledgeMarkdown],
  );
  const knowledgeOverLimit = knowledgeBytes > MAX_USER_ASSISTANT_KNOWLEDGE_BYTES;

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        category,
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        knowledgeMarkdown,
        recommendedRoutingMode: routingMode,
      };
      return editing
        ? patchUpdateUserCustomAssistant(editing.id, payload)
        : postCreateUserCustomAssistant(payload);
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['user-custom-assistants'] });
      void queryClient.invalidateQueries({ queryKey: ['user-key-custom-bindings'] });
      toast.success(editing ? ws.assistantUpdatedToast : ws.assistantCreatedToast);
      onSaved?.(res.assistant);
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_USER_ASSISTANT_KNOWLEDGE_BYTES) {
      toast.error(ws.knowledgeTooLargeError);
      return;
    }
    setKnowledgeMarkdown(prev => (prev.trim() ? `${prev.trim()}\n\n${text.trim()}` : text.trim()));
  };

  const canSubmit =
    name.trim().length >= 2 &&
    systemPrompt.trim().length >= 4 &&
    !knowledgeOverLimit &&
    !saveMutation.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? ws.modalEditTitle : ws.modalCreateTitle}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-3xl border bg-card shadow-xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b px-6 py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary shrink-0" />
              <h2 className="text-sm font-semibold">
                {editing ? ws.modalEditTitle : ws.modalCreateTitle}
              </h2>
            </div>
            <p className="text-xs text-muted-foreground">{ws.modalSubtitle}</p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={tc('Close')} onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <form
          className="flex-1 overflow-y-auto p-6 space-y-4"
          onSubmit={e => {
            e.preventDefault();
            if (canSubmit) saveMutation.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{ws.fieldName}</label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={ws.fieldNamePlaceholder}
                maxLength={100}
                required
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">{ws.fieldSlug}</label>
              <Input
                value={slug}
                onChange={e => setSlug(e.target.value)}
                placeholder={ws.fieldSlugPlaceholder}
                maxLength={63}
                className="text-xs font-mono"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{ws.fieldCategory}</label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value as AssistantCategory)}
                className="h-9 w-full rounded-lg border bg-background px-3 text-xs"
              >
                {ASSISTANT_CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>
                    {tc(CATEGORY_LABELS[cat])}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">{ws.fieldRoutingMode}</label>
              <select
                value={routingMode}
                onChange={e => setRoutingMode(e.target.value as KeyRoutingMode)}
                className="h-9 w-full rounded-lg border bg-background px-3 text-xs"
              >
                <option value="eco">{tc('Eco (Fast)')}</option>
                <option value="balanced">{tc('Balanced')}</option>
                <option value="max">{tc('Max Quality')}</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">{ws.fieldDescription}</label>
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={ws.fieldDescriptionPlaceholder}
              maxLength={500}
              className="text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">{ws.fieldSystemPrompt}</label>
            <Textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder={ws.fieldSystemPromptPlaceholder}
              maxLength={MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS}
              rows={5}
              required
              className="text-xs font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-medium flex items-center gap-1.5">
                <FileText className="size-3.5 text-primary" />
                {ws.fieldKnowledge}
              </label>
              <div className="flex items-center gap-2">
                <span
                  className={`text-[11px] font-mono ${
                    knowledgeOverLimit ? 'text-destructive font-semibold' : 'text-muted-foreground'
                  }`}
                >
                  {formatWorkspaceString(ws.knowledgeByteUsage, {
                    used: (knowledgeBytes / 1024).toFixed(1),
                    max: (MAX_USER_ASSISTANT_KNOWLEDGE_BYTES / 1024).toFixed(0),
                  })}
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.markdown,.txt,text/markdown,text/plain"
                  className="hidden"
                  onChange={e => {
                    void handleImportFile(e.target.files?.[0]);
                    e.currentTarget.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="size-3 mr-1" />
                  {ws.importMarkdownFile}
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">{ws.fieldKnowledgeHint}</p>
            <Textarea
              value={knowledgeMarkdown}
              onChange={e => setKnowledgeMarkdown(e.target.value)}
              placeholder={ws.fieldKnowledgePlaceholder}
              rows={6}
              className="text-xs font-mono"
            />
            {knowledgeOverLimit && (
              <p className="text-[11px] text-destructive">{ws.knowledgeTooLargeError}</p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {ws.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {saveMutation.isPending ? ws.creatingAssistant : ws.saveAssistant}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
