export type SnippetLanguage = 'curl' | 'node' | 'python'

export const SNIPPET_LANGUAGES: Array<{ value: SnippetLanguage; label: string }> = [
  { value: 'curl', label: 'cURL' },
  { value: 'node', label: 'Node.js' },
  { value: 'python', label: 'Python' },
]

/**
 * Ready-to-paste examples of calling the gateway from a web app's BACKEND with a client key. The key is
 * never written into them: it is read from an environment variable, as it should be in the real code.
 */
export function integrationSnippet(language: SnippetLanguage, baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '')
  switch (language) {
    case 'curl':
      return `curl ${url}/chat/completions \\
  -H "Authorization: Bearer $FREELLM_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-End-User: customer-42" \\
  -d '{
    "model": "auto",
    "messages": [
      { "role": "system", "content": "You are the assistant of my website. Answer in the language of the user." },
      { "role": "system", "content": "Page data: ..." },
      { "role": "user", "content": "Hello" }
    ]
  }'`
    case 'node':
      return `// Runs on YOUR server (API route or backend), never in the browser.
// Put the key in an environment variable: FREELLM_KEY=sk-cp-...
// endUserId: your own id for the visitor (no email needed); it gives per-visitor numbers and limits.
export async function askAI(history, userMessage, pageData, endUserId) {
  const res = await fetch("${url}/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${process.env.FREELLM_KEY}\`,
      "X-End-User": String(endUserId),
    },
    body: JSON.stringify({
      model: "auto",
      messages: [
        { role: "system", content: "You are the assistant of my website." },
        { role: "system", content: \`Page data: \${JSON.stringify(pageData)}\` },
        ...history, // [{ role: "user" | "assistant", content: "..." }]
        { role: "user", content: userMessage },
      ],
    }),
  })
  if (!res.ok) throw new Error(\`AI error \${res.status}: \${await res.text()}\`)
  const data = await res.json()
  return data.choices[0].message.content
}`
    case 'python':
      return `# Runs on YOUR server, never in the browser.
# pip install openai   and   export FREELLM_KEY=sk-cp-...
import os
from openai import OpenAI

client = OpenAI(base_url="${url}", api_key=os.environ["FREELLM_KEY"])

def ask_ai(history, user_message, page_data, end_user_id):
    reply = client.chat.completions.create(
        extra_headers={"X-End-User": str(end_user_id)},  # per-visitor numbers and limits
        model="auto",
        messages=[
            {"role": "system", "content": "You are the assistant of my website."},
            {"role": "system", "content": f"Page data: {page_data}"},
            *history,  # [{"role": "user" | "assistant", "content": "..."}]
            {"role": "user", "content": user_message},
        ],
    )
    return reply.choices[0].message.content`
  }
}

export interface TestResultView {
  status: number
  ok: boolean
  latencyMs: number
  model: string | null
  platform: string | null
  reply: string | null
  usage: { inputTokens: number; outputTokens: number } | null
  error: { message: string; code: string | null; type: string | null } | null
  retryAfter: number | null
}

/** One sentence on what a failed test means and what to change. */
export function testHint(r: TestResultView): string | null {
  if (r.ok) return null
  switch (r.error?.code) {
    case 'model_not_allowed':
    case 'model_required':
      return 'The key\'s model list refuses this. Pick an allowed model, or change the list under Restrictions.'
    case 'profile_rate_limit_exceeded':
      return `The per-minute limit is reached${r.retryAfter ? `; try again in ${r.retryAfter} s` : ''}. Raise it above if it is too low.`
    case 'profile_quota_exceeded':
      return `The allowance is used up${r.retryAfter ? `; it frees up in about ${r.retryAfter} s` : ''}. Raise it under Allowances.`
  }
  if (r.error?.code === 'model_not_found') return 'That model is not in the catalog. Use auto (leave the model empty) or pick one from the Models page.'
  if (r.status === 401) return 'The key was rejected: the profile is disabled, or its key was rotated or deleted.'
  if (r.status === 400 && /may use/i.test(r.error?.message ?? '')) return 'None of the models in the key\'s list is enabled. Enable one on the Models page or widen the list.'
  if (r.status === 0) return 'The dashboard could not reach this server\'s own API.'
  if (r.status === 429 || r.status >= 500) return 'The provider side failed or is out of capacity. Check the Keys page for provider health.'
  return null
}
