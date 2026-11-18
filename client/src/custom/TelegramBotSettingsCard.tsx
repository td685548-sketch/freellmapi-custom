import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Send } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Switch } from '@/components/ui/switch'
import { useSessionRevision } from './session-state'
import { useUserSession } from './use-session'
import { useCustomT } from './i18n/use-custom-t'

export interface TelegramBotSettingsView {
  enabled: boolean
  hasBotToken: boolean
  maskedBotToken: string
  chatId: string
  messageThreadId: number | null
  notifyProviderErrors: boolean
  notifyRegistrationRequests: boolean
  notifyQuotaAlerts: boolean
  interactiveApprovalEnabled: boolean
}

interface TelegramDraft {
  botToken?: string
  chatId?: string
  messageThreadId?: string
}

const validChatId = (raw: string): boolean => {
  const trimmed = raw.trim()
  return trimmed === '' || /^-?\d+$|^@[A-Za-z0-9_]{4,}$/.test(trimmed)
}

export function TelegramBotSettingsCard() {
  const tc = useCustomT()
  const { hasPermission } = useUserSession()
  const revision = useSessionRevision()
  const queryClient = useQueryClient()

  const canView = hasPermission('view_settings') || hasPermission('edit_settings')
  const canEdit = hasPermission('edit_settings')

  const queryKey = ['telegram-alert-settings', revision]
  const { data } = useQuery<TelegramBotSettingsView>({
    queryKey,
    queryFn: () => apiFetch<TelegramBotSettingsView>('/api/settings/telegram-alerts'),
    enabled: canView,
    retry: false,
  })

  const [draft, setDraft] = useState<TelegramDraft>({})

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<TelegramBotSettingsView>('/api/settings/telegram-alerts', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKey, next)
      setDraft({})
      toast.success(tc('Telegram bot settings saved'))
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to save Telegram bot settings'))
    },
  })

  const testMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ delivery: { sent: boolean; messageId: number | null }; settings: TelegramBotSettingsView }>(
        '/api/settings/telegram-alerts/test',
        { method: 'POST', body: '{}' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['user-notifications'] })
      toast.success(tc('Test alert sent to Telegram and in-app notifications'))
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to send Telegram test alert'))
    },
  })

  if (!canView || !data) return null

  const chatId = draft.chatId ?? data.chatId
  const threadRaw =
    draft.messageThreadId ?? (data.messageThreadId === null ? '' : String(data.messageThreadId))
  const botTokenInput = draft.botToken ?? ''

  const parsedThread =
    threadRaw.trim() === ''
      ? { ok: true as const, value: null }
      : Number.isInteger(Number(threadRaw.trim())) && Number(threadRaw.trim()) > 0
        ? { ok: true as const, value: Number(threadRaw.trim()) }
        : { ok: false as const, value: null }

  const valid = validChatId(chatId) && parsedThread.ok
  const dirty =
    botTokenInput.trim() !== '' ||
    chatId.trim() !== data.chatId ||
    (parsedThread.ok && parsedThread.value !== data.messageThreadId)

  const handleSaveCredentials = () => {
    if (!valid) return
    const payload: Record<string, unknown> = {
      chatId: chatId.trim(),
      messageThreadId: parsedThread.value,
    }
    if (botTokenInput.trim() !== '') {
      payload.botToken = botTokenInput.trim()
    }
    saveMutation.mutate(payload)
  }

  return (
    <div className="mt-4 space-y-3 rounded-2xl border bg-card/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Bot className="size-4 text-primary" />
            <span>{tc('Telegram Ops Bot & 1-Tap Approval')}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {tc('Instant Telegram alerts when OAuth/cookie provider accounts fail, quota warnings fire, or new users request access (with inline Approve/Reject buttons).')}
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-medium">
          <Switch
            size="sm"
            checked={data.enabled}
            disabled={!canEdit || saveMutation.isPending}
            onCheckedChange={(enabled) => saveMutation.mutate({ enabled })}
            aria-label={tc('Enable Telegram Ops Bot')}
          />
          <span>{data.enabled ? tc('Enabled') : tc('Disabled')}</span>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="block text-[11px] font-medium text-muted-foreground">
            {tc('Bot Token (@BotFather)')}
          </label>
          <PasswordInput
            value={botTokenInput}
            disabled={!canEdit}
            placeholder={
              data.hasBotToken
                ? `${tc('Saved')}: ${data.maskedBotToken}`
                : '123456789:AAH...'
            }
            onChange={(e) => setDraft((prev) => ({ ...prev, botToken: e.target.value }))}
            className="h-8 text-xs font-mono"
          />
          {canEdit && data.hasBotToken && (
            <button
              type="button"
              onClick={() => saveMutation.mutate({ botToken: '' })}
              className="text-[10px] text-muted-foreground underline hover:text-destructive"
            >
              {tc('Clear saved token')}
            </button>
          )}
        </div>

        <div className="space-y-1">
          <label className="block text-[11px] font-medium text-muted-foreground">
            {tc('Admin / Group Chat ID')}
          </label>
          <Input
            value={chatId}
            disabled={!canEdit}
            placeholder="-1001234567890"
            onChange={(e) => setDraft((prev) => ({ ...prev, chatId: e.target.value }))}
            className="h-8 text-xs font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            {tc('Only this Chat ID is authorized to click Approve/Reject buttons.')}
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-[11px] font-medium text-muted-foreground">
            {tc('Topic Thread ID (optional)')}
          </label>
          <Input
            type="number"
            min={1}
            value={threadRaw}
            disabled={!canEdit}
            placeholder={tc('None')}
            onChange={(e) => setDraft((prev) => ({ ...prev, messageThreadId: e.target.value }))}
            className="h-8 text-xs tabular-nums"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 border-t pt-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
          <span>{tc('Alert when OAuth / Cookie provider account fails')}</span>
          <Switch
            size="sm"
            checked={data.notifyProviderErrors}
            disabled={!canEdit || saveMutation.isPending}
            onCheckedChange={(notifyProviderErrors) => saveMutation.mutate({ notifyProviderErrors })}
          />
        </label>

        <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
          <span>{tc('Alert on new & resubmitted registration requests')}</span>
          <Switch
            size="sm"
            checked={data.notifyRegistrationRequests}
            disabled={!canEdit || saveMutation.isPending}
            onCheckedChange={(notifyRegistrationRequests) =>
              saveMutation.mutate({ notifyRegistrationRequests })
            }
          />
        </label>

        <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
          <span>{tc('1-tap Approve / Reject inline buttons in Telegram')}</span>
          <Switch
            size="sm"
            checked={data.interactiveApprovalEnabled}
            disabled={!canEdit || saveMutation.isPending}
            onCheckedChange={(interactiveApprovalEnabled) =>
              saveMutation.mutate({ interactiveApprovalEnabled })
            }
          />
        </label>

        <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
          <span>{tc('Forward 80% / 100% quota & error spike alerts')}</span>
          <Switch
            size="sm"
            checked={data.notifyQuotaAlerts}
            disabled={!canEdit || saveMutation.isPending}
            onCheckedChange={(notifyQuotaAlerts) => saveMutation.mutate({ notifyQuotaAlerts })}
          />
        </label>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="text-[11px] text-destructive">
            {!valid && tc('Enter a valid numeric Chat ID (e.g. 123456789 or -100...) and optional positive Thread ID.')}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={dirty || !data.hasBotToken || !data.chatId || testMutation.isPending}
              onClick={() => testMutation.mutate()}
              title={dirty ? tc('Save first') : undefined}
            >
              <Send className="mr-1 size-3" />
              {testMutation.isPending ? tc('Sending…') : tc('Send test to Telegram')}
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={!dirty || !valid || saveMutation.isPending}
              onClick={handleSaveCredentials}
            >
              {saveMutation.isPending ? tc('Saving…') : tc('Save Telegram bot')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
