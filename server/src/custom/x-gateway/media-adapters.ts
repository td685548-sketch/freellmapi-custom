import { randomUUID } from 'node:crypto';
import { resolveCopilotToken } from '../provider-accounts/copilot.js';
import { USER_AGENT } from '../provider-accounts/http.js';
import { decodeJwtPayload, parseOAuthCredential } from '../provider-accounts/oauth-credentials.js';
import { parseOAuthBundle } from '../provider-accounts/oauth-wire-executors.js';
import type { AccountRow } from '../provider-accounts/store.js';
import { proxyFetch } from '../../lib/proxy.js';

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 60_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const BLOCKED_SUBSCRIPTION_EMBEDDING = new Set(['codex', 'claude', 'gemini-cli', 'kiro']);

function pcm16ToWav(pcmBuffer: Buffer, sampleRate = 24_000, channels = 1, bitsPerSample = 16): Buffer {
  const dataSize = pcmBuffer.length;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function splitModelVoice(modelId: string, defaultModel: string, defaultVoice: string): { model: string; voice: string } {
  if (!modelId) return { model: defaultModel, voice: defaultVoice };
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    return {
      model: modelId.slice(0, slash) || defaultModel,
      voice: modelId.slice(slash + 1) || defaultVoice,
    };
  }
  return { model: modelId, voice: defaultVoice };
}

export async function executeProviderEmbedding(params: {
  account: AccountRow;
  credential: string;
  modelId: string;
  body: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const { account, credential, modelId, body } = params;
  if (BLOCKED_SUBSCRIPTION_EMBEDDING.has(account.provider)) {
    return null;
  }

  if (account.provider === 'gemini') {
    const cleanModel = modelId.startsWith('models/') ? modelId : `models/${modelId}`;
    const isBatch = Array.isArray(body.input);
    const op = isBatch ? 'batchEmbedContents' : 'embedContent';
    const dim = Number(body.dimensions);
    const hasDim = Number.isFinite(dim) && dim > 0;
    const payload = isBatch
      ? {
          requests: (body.input as unknown[]).map(text => ({
            model: cleanModel,
            content: { parts: [{ text: String(text) }] },
            ...(hasDim ? { outputDimensionality: dim } : {}),
          })),
        }
      : {
          model: cleanModel,
          content: { parts: [{ text: String(body.input) }] },
          ...(hasDim ? { outputDimensionality: dim } : {}),
        };
    const res = await proxyFetch(
      `https://generativelanguage.googleapis.com/v1beta/${cleanModel}:${op}?key=${encodeURIComponent(credential)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      account.platform,
      'embedding',
      60_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as Record<string, any>;
    if (json.object === 'list' && Array.isArray(json.data)) return json;
    const items = Array.isArray(json.embeddings)
      ? json.embeddings.map((emb: any, index: number) => ({ object: 'embedding', index, embedding: emb?.values ?? [] }))
      : json.embedding?.values
        ? [{ object: 'embedding', index: 0, embedding: json.embedding.values }]
        : [];
    return {
      object: 'list',
      data: items,
      model: modelId,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  }

  if (account.provider === 'github-copilot') {
    const token = await resolveCopilotToken(credential);
    const res = await proxyFetch(
      'https://api.githubcopilot.com/embeddings',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'copilot-integration-id': 'vscode-chat',
          'Editor-Version': 'vscode/1.100.0',
          'Editor-Plugin-Version': 'copilot-chat/0.26.7',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({ ...body, model: modelId }),
      },
      account.platform,
      'embedding',
      60_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  if (account.provider === 'selfhosted-embedding') {
    const rawBase = account.base_url?.trim().replace(/\/+$/, '');
    if (!rawBase || rawBase === 'https://api.openai.com/v1') {
      throw Object.assign(
        new Error('Self-hosted Embedding requires a custom baseUrl on the account; refusing to fall back to api.openai.com.'),
        { status: 400 },
      );
    }
    const cleanBase = rawBase.replace(/\/embeddings$/, '');
    const res = await proxyFetch(
      `${cleanBase}/embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(credential && credential !== 'no-auth' ? { Authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify({ ...body, model: modelId }),
      },
      'custom',
      'embedding',
      60_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  return null;
}

export async function executeProviderSpeech(params: {
  account: AccountRow;
  credential: string;
  modelId: string;
  input: string;
  voice?: string;
  responseFormat?: string;
  extraBody?: Record<string, unknown>;
}): Promise<{ buffer: Buffer; contentType: string } | null> {
  const { account, credential, modelId, input, voice, responseFormat, extraBody } = params;

  if (account.provider === 'elevenlabs') {
    const split = modelId.includes('/') ? splitModelVoice(modelId, 'eleven_flash_v2_5', '21m00Tcm4TlvDq8ikWAM') : null;
    const model = split ? split.model : 'eleven_flash_v2_5';
    const resolvedVoice = voice || (split ? split.voice : modelId) || '21m00Tcm4TlvDq8ikWAM';
    const res = await proxyFetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(resolvedVoice)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': credential },
        body: JSON.stringify({
          text: input,
          model_id: model,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
      account.platform,
      'audio',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }

  if (account.provider === 'gemini') {
    const { model, voice: parsedVoice } = modelId.includes('/')
      ? splitModelVoice(modelId, 'gemini-2.5-flash-preview-tts', 'Kore')
      : { model: /^gemini-/i.test(modelId) ? modelId : 'gemini-2.5-flash-preview-tts', voice: 'Kore' };
    const cleanModel = model.replace(/^models\//, '');
    const resolvedVoice = voice || parsedVoice || 'Kore';
    const res = await proxyFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(credential)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: /:\s/.test(input) ? input : `Say: ${input}` }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: resolvedVoice } } },
          },
        }),
      },
      account.platform,
      'audio',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as Record<string, any>;
    const b64 = json?.candidates?.[0]?.content?.parts?.find((p: any) => typeof p?.inlineData?.data === 'string')?.inlineData?.data;
    if (!b64) throw new Error('Gemini TTS returned no audio data');
    return { buffer: pcm16ToWav(Buffer.from(b64, 'base64')), contentType: 'audio/wav' };
  }

  if (account.provider === 'xiaomi-mimo') {
    const { model, voice: parsedVoice } = modelId.includes('/')
      ? splitModelVoice(modelId, 'mimo-v2.5-tts', 'mimo_default')
      : { model: modelId || 'mimo-v2.5-tts', voice: 'mimo_default' };
    const cleanModel = model.replace(/^xiaomi-mimo\//, '') || 'mimo-v2.5-tts';
    const resolvedVoice = voice || parsedVoice || 'mimo_default';
    const messages: Array<{ role: string; content: string }> = [{ role: 'assistant', content: input }];
    if (typeof extraBody?.instructions === 'string' && extraBody.instructions) {
      messages.unshift({ role: 'user', content: extraBody.instructions });
    }
    const res = await proxyFetch(
      'https://api.xiaomimimo.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
        body: JSON.stringify({
          model: cleanModel,
          stream: false,
          messages,
          audio: { format: 'wav', voice: resolvedVoice },
        }),
      },
      account.platform,
      'audio',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as Record<string, any>;
    const audioData = json?.choices?.[0]?.message?.audio?.data;
    if (typeof audioData !== 'string' || !audioData) throw new Error('MiMo TTS returned no audio');
    return { buffer: Buffer.from(audioData, 'base64'), contentType: 'audio/wav' };
  }

  if (account.provider === 'deepgram') {
    const resolvedModel = voice || modelId || 'aura-asteria-en';
    const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(resolvedModel)}`;
    const res = await proxyFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Token ${credential}` },
        body: JSON.stringify({ text: input }),
      },
      account.platform,
      'audio',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }

  if (account.provider === 'fish-audio') {
    const res = await proxyFetch(
      'https://api.fish.audio/v1/tts',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential}`,
          model: modelId || 's2.1-pro-free',
        },
        body: JSON.stringify({
          text: input,
          format: 'mp3',
          ...(voice ? { reference_id: voice } : {}),
        }),
      },
      account.platform,
      'audio',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }

  if (account.provider === 'cartesia') {
    const res = await proxyFetch(
      'https://api.cartesia.ai/tts/bytes',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': credential,
          'Cartesia-Version': '2024-06-10',
        },
        body: JSON.stringify({
          model_id: modelId || 'sonic-2',
          transcript: input,
          voice: { mode: 'id', id: voice || 'a0e99841-438c-4a64-b679-ae501e7d6091' },
          output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
        }),
      },
      account.platform,
      'audio',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }

  if (account.provider === 'selfhosted-tts') {
    const rawBase = account.base_url?.trim().replace(/\/+$/, '');
    const resolvedBase = rawBase && rawBase !== 'https://api.openai.com/v1'
      ? rawBase
      : 'http://localhost:8880';
    const base = resolvedBase
      .replace(/\/v1\/audio\/speech$/, '')
      .replace(/\/v1$/, '');
    const { model, voice: parsedVoice } = splitModelVoice(modelId, 'kokoro', 'af_heart');
    const res = await proxyFetch(
      `${base}/v1/audio/speech`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(credential && credential !== 'no-auth' ? { Authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify({
          model,
          voice: voice || parsedVoice || 'af_heart',
          input,
          response_format: responseFormat || 'mp3',
        }),
      },
      'custom',
      'audio',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }

  return null;
}

export async function executeProviderTranscription(params: {
  account: AccountRow;
  credential: string;
  modelId: string;
  file: Express.Multer.File;
  language?: string;
  responseFormat?: string;
}): Promise<{ rawBody: string; contentType: string } | null> {
  const { account, credential, modelId, file, language, responseFormat } = params;

  if (account.provider === 'codex') {
    const structured = parseOAuthCredential(credential);
    const bundle = parseOAuthBundle(credential);
    const accessToken = structured?.accessToken ?? bundle.accessToken;
    const claims = decodeJwtPayload(accessToken)?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    const bundleAccountId = typeof bundle.raw?.accountId === 'string'
      ? bundle.raw.accountId
      : typeof bundle.raw?.chatgptAccountId === 'string'
        ? bundle.raw.chatgptAccountId
        : undefined;
    const accountId = structured?.accountId
      ?? bundleAccountId
      ?? (typeof claims?.chatgpt_account_id === 'string' ? claims.chatgpt_account_id : undefined);
    if (!accessToken || !accountId) {
      throw Object.assign(new Error('Codex STT requires a valid Codex OAuth credential with accountId'), { status: 401 });
    }
    const boundary = `----thruline-codex-${randomUUID()}`;
    const partHead = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: ${file.mimetype || 'audio/wav'}\r\n\r\n`,
    );
    const partTail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([partHead, file.buffer, partTail]);
    const res = await proxyFetch(
      'https://chatgpt.com/backend-api/transcribe',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'ChatGPT-Account-Id': accountId,
          'User-Agent': 'codex_cli_rs/0.167.1',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
      account.platform,
      'transcription',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string };
    const text = typeof data?.text === 'string' ? data.text : '';
    return responseFormat === 'text'
      ? { rawBody: text, contentType: 'text/plain; charset=utf-8' }
      : { rawBody: JSON.stringify({ text }), contentType: 'application/json' };
  }

  if (account.provider === 'deepgram') {
    const url = new URL('https://api.deepgram.com/v1/listen');
    url.searchParams.set('model', modelId || 'nova-2');
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('punctuate', 'true');
    if (language?.trim()) url.searchParams.set('language', language.trim());
    else url.searchParams.set('detect_language', 'true');
    const res = await proxyFetch(
      url.toString(),
      {
        method: 'POST',
        headers: { Authorization: `Token ${credential}`, 'Content-Type': file.mimetype || 'audio/mpeg' },
        body: new Uint8Array(file.buffer),
      },
      account.platform,
      'transcription',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = (await res.json()) as Record<string, any>;
    const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    return responseFormat === 'text'
      ? { rawBody: String(text), contentType: 'text/plain; charset=utf-8' }
      : { rawBody: JSON.stringify({ text }), contentType: 'application/json' };
  }

  if (account.provider === 'assemblyai') {
    const authHeaders = { Authorization: credential };
    const up = await proxyFetch(
      'https://api.assemblyai.com/v2/upload',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(file.buffer),
      },
      account.platform,
      'transcription',
      120_000,
    );
    if (!up.ok) {
      const txt = await up.text().catch(() => '');
      throw new Error(`HTTP ${up.status}: ${txt.slice(0, 200)}`);
    }
    const { upload_url } = (await up.json()) as { upload_url: string };
    const sub = await proxyFetch(
      'https://api.assemblyai.com/v2/transcript',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_url: upload_url,
          speech_models: [modelId || 'universal'],
          ...(language?.trim() ? { language_code: language.trim() } : { language_detection: true }),
        }),
      },
      account.platform,
      'transcription',
      60_000,
    );
    if (!sub.ok) {
      const txt = await sub.text().catch(() => '');
      throw new Error(`HTTP ${sub.status}: ${txt.slice(0, 200)}`);
    }
    const { id } = (await sub.json()) as { id: string };
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const poll = await proxyFetch(
        `https://api.assemblyai.com/v2/transcript/${encodeURIComponent(id)}`,
        { headers: authHeaders },
        account.platform,
        'transcription',
        30_000,
      );
      if (!poll.ok) continue;
      const statusJson = (await poll.json()) as { status?: string; text?: string; error?: string };
      if (statusJson.status === 'completed') {
        const text = statusJson.text ?? '';
        return responseFormat === 'text'
          ? { rawBody: text, contentType: 'text/plain; charset=utf-8' }
          : { rawBody: JSON.stringify({ text }), contentType: 'application/json' };
      }
      if (statusJson.status === 'error') {
        throw new Error(statusJson.error || 'AssemblyAI transcription failed');
      }
    }
    throw new Error('AssemblyAI transcription timed out');
  }

  if (account.provider === 'elevenlabs') {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || 'audio/mpeg' }), file.originalname || 'audio.mp3');
    form.append('model_id', modelId || 'scribe_v1');
    if (language?.trim()) form.append('language_code', language.trim());
    const res = await proxyFetch(
      'https://api.elevenlabs.io/v1/speech-to-text',
      { method: 'POST', headers: { 'xi-api-key': credential }, body: form },
      account.platform,
      'transcription',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string };
    const text = data.text ?? '';
    return responseFormat === 'text'
      ? { rawBody: text, contentType: 'text/plain; charset=utf-8' }
      : { rawBody: JSON.stringify({ text }), contentType: 'application/json' };
  }

  if (account.provider === 'gemini') {
    const cleanModel = (modelId || 'gemini-2.5-flash').replace(/^models\//, '');
    const res = await proxyFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(credential)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: file.mimetype || 'audio/mpeg', data: file.buffer.toString('base64') } },
                { text: language?.trim() ? `Transcribe this audio in ${language.trim()} accurately. Output only the transcript.` : 'Transcribe this audio accurately. Output only the transcript.' },
              ],
            },
          ],
        }),
      },
      account.platform,
      'transcription',
      120_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as Record<string, any>;
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('') ?? '';
    return responseFormat === 'text'
      ? { rawBody: text, contentType: 'text/plain; charset=utf-8' }
      : { rawBody: JSON.stringify({ text }), contentType: 'application/json' };
  }

  return null;
}
