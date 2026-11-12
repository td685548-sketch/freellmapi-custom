export interface BuiltinSkillDefinition {
  id: string;
  name: string;
  category: 'entry' | 'chat' | 'media' | 'audio' | 'data' | 'search' | 'tools';
  description: string;
  endpoint: string | null;
  icon: string;
  isEntry?: boolean;
  githubPath: string;
  content: string;
}

export const BUILTIN_SKILLS: BuiltinSkillDefinition[] = [
  {
    id: '9router',
    name: '9Router (Entry & Setup)',
    category: 'entry',
    isEntry: true,
    description: 'Setup and index of all gateway capabilities. Start here — covers base URL, auth, model discovery, and links to every capability skill.',
    endpoint: null,
    icon: 'Hub',
    githubPath: '9router/SKILL.md',
    content: `---
name: 9router
description: Entry point for 9Router & FreeLLMAPI Thruline — local/remote AI gateway with OpenAI-compatible REST for chat, image, TTS, STT, embeddings, web search, web fetch. Use when the user mentions 9Router, NINEROUTER_URL, GATEWAY_URL, or wants AI without writing provider boilerplate.
---

# 9Router & FreeLLMAPI Thruline

Local/remote unified AI routing gateway exposing OpenAI, Anthropic, and Gemini compatible REST endpoints. One key, many providers, automatic fallback.

## Setup

\`\`\`bash
export GATEWAY_URL="{{GATEWAY_URL}}"      # local or public Cloudflare Tunnel URL
export GATEWAY_KEY="sk-..."              # from Dashboard → Keys / Endpoint
\`\`\`

All requests: \`\${GATEWAY_URL}/v1/...\` with header \`Authorization: Bearer \${GATEWAY_KEY}\` (or \`\${GATEWAY_URL}/x/v1/...\` for admin routes).

Verify: \`curl \${GATEWAY_URL}/api/health\` → \`{"ok":true}\`

## Discover Models

\`\`\`bash
curl \${GATEWAY_URL}/v1/models                  # chat/LLM models
curl \${GATEWAY_URL}/v1/models/image            # image generation models
curl \${GATEWAY_URL}/v1/models/tts              # text-to-speech voices
curl \${GATEWAY_URL}/v1/models/embedding        # embeddings models
curl \${GATEWAY_URL}/v1/models/web              # web search + fetch tools
curl \${GATEWAY_URL}/v1/models/stt              # speech-to-text models
\`\`\`

Use \`data[].id\` as \`model\` in requests. Combos appear with \`owned_by:"combo"\`.

Response shape:
\`\`\`json
{
  "object": "list",
  "data": [
    { "id": "openai/gpt-4o", "object": "model", "owned_by": "openai", "created": 1735000000 },
    { "id": "claude-3-5-sonnet", "object": "model", "owned_by": "anthropic", "created": 1735000000 }
  ]
}
\`\`\`

## Capability Skills

When you need a specific capability, inspect the dedicated skill:

| Capability | Endpoint | Skill ID |
|---|---|---|
| Chat & Code-gen | \`POST /v1/chat/completions\` & \`POST /x/v1/messages\` | \`9router-chat\` |
| Image Generation | \`POST /v1/images/generations\` | \`9router-image\` |
| Video Generation | \`POST /v1/videos/generations\` | \`9router-video\` |
| Text-to-Speech | \`POST /v1/audio/speech\` | \`9router-tts\` |
| Speech-to-Text | \`POST /v1/audio/transcriptions\` | \`9router-stt\` |
| Embeddings | \`POST /v1/embeddings\` | \`9router-embeddings\` |
| Web Search | \`POST /v1/search\` | \`9router-web-search\` |
| Web Fetch | \`POST /v1/web/fetch\` | \`9router-web-fetch\` |
| Protocol Translator | \`POST /api/x-gateway/translator/inspect\` | \`9router-translator\` |

## Error Codes

- **401 Unauthorized**: set or refresh \`GATEWAY_KEY\`
- **400 Invalid model format**: verify \`model\` exists via \`/v1/models\`
- **503 All accounts unavailable**: wait for provider cooldown or add another provider account
`,
  },
  {
    id: '9router-chat',
    name: 'Chat & Code Generation',
    category: 'chat',
    description: 'Chat / code generation via OpenAI /v1/chat/completions or Anthropic /v1/messages format with streaming + auto-fallback combos.',
    endpoint: '/v1/chat/completions',
    icon: 'MessageSquare',
    githubPath: '9router-chat/SKILL.md',
    content: `---
name: 9router-chat
description: Chat / code generation via 9Router using OpenAI /v1/chat/completions or Anthropic /v1/messages format with streaming + auto-fallback combos. Use when the user wants to ask an LLM, generate code, summarize text, or run prompts.
---

# 9Router — Chat & Code Generation

Requires \`GATEWAY_URL\` (and \`GATEWAY_KEY\` if auth enabled).

## Endpoints

- \`POST \${GATEWAY_URL}/v1/chat/completions\` — OpenAI format
- \`POST \${GATEWAY_URL}/x/v1/messages\` or \`POST \${GATEWAY_URL}/v1/messages\` — Anthropic format

## Discover

\`\`\`bash
curl \${GATEWAY_URL}/v1/models | jq '.data[].id'
\`\`\`

Combos (e.g. \`vip\`, \`coding-combo\`) auto-fallback through multiple providers seamlessly.

## OpenAI Format Example

\`\`\`bash
curl -X POST \${GATEWAY_URL}/v1/chat/completions \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"Hello!"}],"stream":false}'
\`\`\`

JavaScript (OpenAI SDK):
\`\`\`js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: \`\${process.env.GATEWAY_URL}/v1\`, apiKey: process.env.GATEWAY_KEY });
const res = await client.chat.completions.create({
  model: "openai/gpt-4o",
  messages: [{ role: "user", content: "Hi" }],
  stream: true,
});
for await (const chunk of res) process.stdout.write(chunk.choices[0]?.delta?.content || "");
\`\`\`

## Anthropic Format Example

\`\`\`bash
curl -X POST \${GATEWAY_URL}/v1/messages \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'
\`\`\`

## Streaming Response

Streaming (\`stream: true\`) emits SSE chunks:
\`\`\`text
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}
data: [DONE]
\`\`\`
`,
  },
  {
    id: '9router-image',
    name: 'Image Generation',
    category: 'media',
    description: 'Generate images via /v1/images/generations using OpenAI DALL-E, Gemini Imagen, FLUX, MiniMax, SDWebUI, ComfyUI, etc.',
    endpoint: '/v1/images/generations',
    icon: 'Image',
    githubPath: '9router-image/SKILL.md',
    content: `---
name: 9router-image
description: Generate images via 9Router /v1/images/generations using OpenAI / Gemini Imagen / DALL-E / FLUX / MiniMax / SDWebUI. Use when the user wants to create, draw, or render pictures.
---

# 9Router — Image Generation

## Endpoint

\`POST \${GATEWAY_URL}/v1/images/generations\`

| Field | Required | Notes |
|---|---|---|
| \`model\` | yes | from \`/v1/models/image\` (e.g. \`openai/dall-e-3\`, \`gemini/imagen-3\`) |
| \`prompt\` | yes | visual description of the desired image |
| \`n\` | no | count (default 1) |
| \`size\` | no | \`1024x1024\`, \`1792x1024\`, \`1024x1792\` |
| \`response_format\` | no | \`url\` (default) or \`b64_json\` |

Add query \`?response_format=binary\` to download the raw image bytes directly to a file.

## Example

\`\`\`bash
curl -X POST "\${GATEWAY_URL}/v1/images/generations?response_format=binary" \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gemini/imagen-3","prompt":"watercolor sunset over calm ocean waves","size":"1024x1024"}' \\
  --output image.png
\`\`\`
`,
  },
  {
    id: '9router-video',
    name: 'Video Generation',
    category: 'media',
    description: 'Generate videos via /v1/videos/generations using xAI Grok Imagine (grok-imagine-video). Async job flow with request_id polling.',
    endpoint: '/v1/videos/generations',
    icon: 'Video',
    githubPath: '9router-video/SKILL.md',
    content: `---
name: 9router-video
description: Generate videos via 9Router /v1/videos/generations using xAI Grok Imagine (grok-imagine-video). Async job flow with polling.
---

# 9Router — Video Generation

Video generation is asynchronous: submit the request, obtain a \`request_id\`, then poll until the job reaches \`done\` or \`failed\`.

## Endpoints

| Endpoint | Purpose |
|---|---|
| \`POST /v1/videos/generations\` | text-to-video / image-to-video |
| \`GET /v1/videos/{request_id}\` | poll status and get MP4 URL |

## Example

1. Submit job:
\`\`\`bash
curl -X POST "\${GATEWAY_URL}/v1/videos/generations" \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"xai/grok-imagine-video","prompt":"A cyberpunk city skyline at dusk with flying vehicles","duration":6,"aspect_ratio":"16:9"}'
# → {"request_id":"job_123"}
\`\`\`

2. Poll status:
\`\`\`bash
curl "\${GATEWAY_URL}/v1/videos/job_123" \\
  -H "Authorization: Bearer \${GATEWAY_KEY}"
# → {"status":"done","video":{"url":"https://.../out.mp4"}}
\`\`\`
`,
  },
  {
    id: '9router-tts',
    name: 'Text-to-Speech (TTS)',
    category: 'audio',
    description: 'Convert text to natural speech audio via /v1/audio/speech using OpenAI, ElevenLabs, Deepgram, Edge TTS, Google TTS, etc.',
    endpoint: '/v1/audio/speech',
    icon: 'Volume2',
    githubPath: '9router-tts/SKILL.md',
    content: `---
name: 9router-tts
description: Text-to-speech via 9Router /v1/audio/speech using OpenAI / ElevenLabs / Edge TTS / Google TTS. Convert text into spoken audio.
---

# 9Router — Text-to-Speech

## Endpoint

\`POST \${GATEWAY_URL}/v1/audio/speech\`

| Field | Required | Notes |
|---|---|---|
| \`model\` | yes | voice model ID (e.g. \`openai/tts-1\`, \`edge-tts/vi-VN-HoaiMyNeural\`) |
| \`input\` | yes | text content to synthesize |
| \`voice\` | no | voice persona (e.g. \`alloy\`, \`echo\`, \`fable\`, \`nova\`) |

## Example

\`\`\`bash
curl -X POST "\${GATEWAY_URL}/v1/audio/speech" \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"openai/tts-1","voice":"alloy","input":"Hello! Welcome to FreeLLMAPI Thruline."}' \\
  --output audio.mp3
\`\`\`
`,
  },
  {
    id: '9router-stt',
    name: 'Speech-to-Text (STT)',
    category: 'audio',
    description: 'Transcribe audio to text via /v1/audio/transcriptions using OpenAI Whisper, Groq Whisper Turbo, Deepgram, Gemini, etc.',
    endpoint: '/v1/audio/transcriptions',
    icon: 'Mic',
    githubPath: '9router-stt/SKILL.md',
    content: `---
name: 9router-stt
description: Speech-to-text via 9Router /v1/audio/transcriptions using OpenAI Whisper / Groq / Gemini. Transcribe audio files to text or subtitles.
---

# 9Router — Speech-to-Text

## Endpoint

\`POST \${GATEWAY_URL}/v1/audio/transcriptions\` (multipart/form-data)

| Field | Required | Notes |
|---|---|---|
| \`file\` | yes | audio file (mp3, wav, m4a, webm, ogg, flac) |
| \`model\` | yes | e.g. \`openai/whisper-1\`, \`groq/whisper-large-v3-turbo\` |
| \`language\` | no | ISO-639-1 code (e.g. \`en\`, \`vi\`) |
| \`response_format\` | no | \`json\` (default), \`text\`, \`srt\`, \`vtt\` |

## Example

\`\`\`bash
curl -X POST "\${GATEWAY_URL}/v1/audio/transcriptions" \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -F "model=openai/whisper-1" \\
  -F "file=@meeting.mp3" \\
  -F "language=en"
\`\`\`
`,
  },
  {
    id: '9router-embeddings',
    name: 'Embeddings (Vectors for RAG)',
    category: 'data',
    description: 'Generate high-dimensional vector embeddings via /v1/embeddings for semantic search, retrieval augmented generation (RAG), and clustering.',
    endpoint: '/v1/embeddings',
    icon: 'Layers',
    githubPath: '9router-embeddings/SKILL.md',
    content: `---
name: 9router-embeddings
description: Generate vector embeddings via 9Router /v1/embeddings using OpenAI / Gemini / Mistral / Voyage for RAG and semantic search.
---

# 9Router — Vector Embeddings

## Endpoint

\`POST \${GATEWAY_URL}/v1/embeddings\`

| Field | Required | Notes |
|---|---|---|
| \`model\` | yes | from \`/v1/models/embedding\` (e.g. \`openai/text-embedding-3-small\`) |
| \`input\` | yes | string or array of strings to embed |
| \`dimensions\` | no | dimension count (OpenAI v3) |

## Example

\`\`\`bash
curl -X POST \${GATEWAY_URL}/v1/embeddings \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"openai/text-embedding-3-small","input":["Retrieval augmented generation with vector embeddings"]}'
\`\`\`
`,
  },
  {
    id: '9router-web-search',
    name: 'Web & X Search',
    category: 'search',
    description: 'Real-time web and X/Twitter search via /v1/search using Tavily, Exa, Brave Search, Serper, Google PSE, or Xquik.',
    endpoint: '/v1/search',
    icon: 'Search',
    githubPath: '9router-web-search/SKILL.md',
    content: `---
name: 9router-web-search
description: Web and X search via 9Router /v1/search using Tavily / Exa / Brave / Serper / Xquik. Search live internet information and articles.
---

# 9Router — Web Search

## Endpoint

\`POST \${GATEWAY_URL}/v1/search\`

| Field | Required | Notes |
|---|---|---|
| \`model\` (or \`provider\`) | yes | e.g. \`tavily\`, \`brave\`, \`exa\`, \`xquik\` |
| \`query\` | yes | search keywords or question |
| \`max_results\` | no | result limit (default 5) |
| \`search_type\` | no | \`web\` (default), \`news\`, or \`x\` |

## Example

\`\`\`bash
curl -X POST \${GATEWAY_URL}/v1/search \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"tavily","query":"Latest updates in agentic AI architecture","max_results":5}'
\`\`\`
`,
  },
  {
    id: '9router-web-fetch',
    name: 'Web Fetch & Markdown Reader',
    category: 'search',
    description: 'Fetch any URL and extract clean Markdown, text, or structured content via /v1/web/fetch using Firecrawl, Jina Reader, Tavily, or Exa.',
    endpoint: '/v1/web/fetch',
    icon: 'Globe',
    githubPath: '9router-web-fetch/SKILL.md',
    content: `---
name: 9router-web-fetch
description: Fetch URL → clean Markdown / text / HTML via 9Router /v1/web/fetch using Firecrawl / Jina Reader / Tavily. Convert web pages to LLM-ready markdown.
---

# 9Router — Web Fetch

## Endpoint

\`POST \${GATEWAY_URL}/v1/web/fetch\`

| Field | Required | Notes |
|---|---|---|
| \`url\` | yes | target webpage URL to extract |
| \`model\` | no | e.g. \`jina-reader\`, \`firecrawl\`, \`tavily\` |
| \`format\` | no | \`markdown\` (default), \`text\`, or \`html\` |

## Example

\`\`\`bash
curl -X POST \${GATEWAY_URL}/v1/web/fetch \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"jina-reader","url":"https://github.com/thanhdo257205/freellmapi-custom","format":"markdown"}'
\`\`\`
`,
  },
  {
    id: '9router-translator',
    name: 'Protocol Translator Inspector',
    category: 'tools',
    description: 'Inspect, debug, and test the 7-step cross-protocol transformation pipeline between OpenAI, Anthropic Claude, and Google Gemini wire formats.',
    endpoint: '/api/x-gateway/translator/inspect',
    icon: 'ArrowLeftRight',
    githubPath: 'docs/TRANSLATOR.md',
    content: `---
name: 9router-translator
description: Cross-protocol translation engine connecting OpenAI Chat Completions, Anthropic Claude Messages, and Google Gemini generateContent with SSE streaming converter.
---

# 9Router — Protocol Translator

## Inspection Endpoint

\`POST \${GATEWAY_URL}/api/x-gateway/translator/inspect\`

Inspect how a request translates across providers before dispatching:

\`\`\`bash
curl -X POST \${GATEWAY_URL}/api/x-gateway/translator/inspect \\
  -H "Authorization: Bearer \${GATEWAY_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "sourceProtocol": "openai_chat",
    "targetProtocol": "anthropic",
    "payload": {
      "model": "gpt-4o",
      "messages": [{"role":"user","content":"Hello world"}]
    }
  }'
\`\`\`

## 7-Step Pipeline Trace

1. **Input Normalization**: Ingest payload, validate schema and message roles.
2. **Intermediate Canon**: Map to unified OpenAI-compatible representation.
3. **Role & Content Mapping**: Convert system prompts, tool results, thinking blocks.
4. **Tool Call Translation**: Standardize tool definition schemas and IDs.
5. **Lossy Field Audit**: Detect unconvertible flags (top_k, logprobs, thinking budget).
6. **Token Estimation**: Fast heuristic token calculation.
7. **Target Serialization**: Produce wire-ready body for target upstream.
`,
  },
];

