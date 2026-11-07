import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CheckCircle2, CircleAlert, Send } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { SNIPPET_LANGUAGES, integrationSnippet, testHint, type SnippetLanguage, type TestResultView } from './integration-snippets'
import { useCustomT } from './i18n/use-custom-t'

const DEFAULT_MESSAGE = 'Reply with one short sentence confirming you are working.'

/**
 * How to connect a web app to this client key: its address, copy-paste backend code, and (for editors)
 * a button that sends one real message with the key and shows what the web would get back.
 */
export function ProfileIntegrationCard({ profileId, canTest }: { profileId: number; canTest: boolean }) {
  const tc = useCustomT()
  const baseUrl = `${typeof window === 'undefined' ? '' : window.location.origin}/v1`
  const [language, setLanguage] = useState<SnippetLanguage>('node')
  const [message, setMessage] = useState(DEFAULT_MESSAGE)
  const [model, setModel] = useState('')
  const [stream, setStream] = useState(false)
  const snippet = integrationSnippet(language, baseUrl)

  const send = useMutation({
    mutationFn: () => apiFetch<{ result: TestResultView; profileEnabled: boolean }>(`/api/client-profiles/${profileId}/test`, {
      method: 'POST',
      body: JSON.stringify({ message: message.trim() || DEFAULT_MESSAGE, ...(model.trim() ? { model: model.trim() } : {}), ...(stream ? { stream: true } : {}) }),
    }),
  })
  const result = send.data?.result
  const hint = result ? testHint(result) : null

  return (
    <section className="rounded-2xl border bg-card p-4 space-y-4" aria-label="Connect your web app">
      <h3 className="text-sm font-semibold">{tc('Connect your web app')}</h3>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{tc('Server address')}</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg border bg-muted/40 px-3 py-1.5 text-xs font-mono" data-testid="base-url">{baseUrl}</code>
          <CopyButton text={baseUrl} label={tc('Copy server address')} className="h-8 w-8" />
        </div>
        <p className="text-xs text-muted-foreground">{tc('Call it from your web app\'s backend, never from the browser, and keep the key (shown once when the profile was created or rotated) in an environment variable such as FREELLM_KEY.')}</p>
      </div>

      <div className="space-y-2">
        <SegmentedControl ariaLabel="Language" value={language} onValueChange={setLanguage} options={SNIPPET_LANGUAGES} />
        <div className="relative">
          <pre className="overflow-x-auto rounded-xl border bg-muted/40 p-3 pr-12 text-xs leading-relaxed"><code>{snippet}</code></pre>
          <CopyButton text={snippet} label={tc('Copy example')} className="absolute right-2 top-2 h-7 w-7" />
        </div>
        <p className="text-xs text-muted-foreground">{tc('The system prompt, the page data and the user\'s chat history are all just entries of')}{' '}<code>{tc('messages')}</code>{tc('; send the whole conversation each time.')}</p>
      </div>

      {canTest && (
        <form
          className="space-y-3 border-t pt-4"
          onSubmit={(e) => { e.preventDefault(); if (!send.isPending) send.mutate() }}
        >
          <p className="text-xs font-medium text-muted-foreground">{tc('Send a test message with this key')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Test message" maxLength={1000} className="h-8 min-w-64 flex-1 text-xs" />
            <Input value={model} onChange={(e) => setModel(e.target.value)} aria-label="Test model" placeholder={tc('auto')} maxLength={200} className="h-8 w-48 text-xs" />
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} className="size-3.5" aria-label="Stream the answer" />{tc('Stream')}</label>
            <Button type="submit" size="sm" className="h-8 text-xs" disabled={send.isPending}>
              <Send className="size-3.5 mr-1" />
              {send.isPending ? tc('Sending…') : tc('Send test')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{tc('A real request: it goes through the key\'s limits, allowances and model list, and counts against them.')}</p>

          {send.isError && <p role="alert" className="text-xs text-destructive">{send.error instanceof Error ? send.error.message : tc('The test could not be run.')}</p>}
          {result && (
            <div role="status" className={`rounded-xl border p-3 space-y-1.5 text-xs ${result.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5'}`}>
              <div className="flex items-center gap-1.5 font-medium">
                {result.ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <CircleAlert className="size-4 text-destructive" />}
                {result.ok ? tc('Working') : tc('Refused or failed ({v})', { v: result.status || 'no answer' })}
                <span className="font-normal text-muted-foreground">· {result.latencyMs.toLocaleString()}{' '}{tc('ms')}</span>
              </div>
              {result.model && <p>{tc('Routed to')}{' '}<strong>{result.model}</strong>{result.platform ? ` (${result.platform})` : ''}{result.usage ? tc(' · {inputTokens} in / {outputTokens} out tokens', { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }) : ''}</p>}
              {result.stream && (
                <p data-testid="stream-stats">{tc('Streamed: first text after')}{' '}<strong>{result.stream.firstTokenMs === null ? '—' : tc('{firstTokenMs} ms', { firstTokenMs: result.stream.firstTokenMs.toLocaleString() })}</strong>
                  {' · '}{result.stream.chunks}{' '}{tc('frames')}{' · '}{result.stream.finished ? tc('ended properly') : tc('did not end properly')}
                </p>
              )}
              {result.reply && <p className="rounded-lg bg-background/70 p-2 whitespace-pre-wrap">{result.reply}</p>}
              {result.error && <p><strong>{result.error.code ?? tc('Error')}:</strong> {result.error.message}</p>}
              {hint && <p className="text-muted-foreground">{hint}</p>}
            </div>
          )}
        </form>
      )}
    </section>
  )
}
