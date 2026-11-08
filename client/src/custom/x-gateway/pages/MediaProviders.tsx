import { useState, useRef, useId } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Binary,
  Check,
  Copy,
  Download,
  Film,
  Globe,
  Image as ImageIcon,
  Mic,
  Palette,
  Save,
  UploadCloud,
  Volume2,
  Wand2,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useUserSession } from '../../use-session';
import { useSessionRevision } from '../../session-state';
import { ProviderMark } from './Providers';
import {
  mediaApi,
  type MediaKind,
  type MediaDefaults,
  type ImageTestResult,
  type TtsTestResult,
  type SttTestResult,
  type EmbeddingTestResult,
  type WebTestResult,
} from '../media-api';
import { useMediaStrings } from '../media-strings';

export default function MediaProviders() {
  const s = useMediaStrings();
  const client = useQueryClient();
  const revision = useSessionRevision();
  const session = useUserSession();
  const canEdit = session.hasPermission('edit_x_settings');

  const [activeKind, setActiveKind] = useState<MediaKind>('image');
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [snippetTab, setSnippetTab] = useState<'curl' | 'python' | 'node'>('curl');

  // Form drafts for defaults
  const [configDraft, setConfigDraft] = useState<MediaDefaults | null>(null);

  // Playground States
  // 1. Image
  const [imagePrompt, setImagePrompt] = useState('A futuristic cityscape bathed in neon dusk, reflections on wet pavement, cinematic lighting 8k');
  const [imageModel, setImageModel] = useState('auto');
  const [imageSize, setImageSize] = useState('1024x1024');
  const [imageResult, setImageResult] = useState<ImageTestResult | null>(null);

  // 2. TTS
  const [ttsInput, setTtsInput] = useState('Hello! FreeLLMAPI X Gateway text-to-speech is working properly.');
  const [ttsModel, setTtsModel] = useState('auto');
  const [ttsVoice, setTtsVoice] = useState('alloy');
  const [ttsSpeed, setTtsSpeed] = useState(1.0);
  const [ttsFormat, setTtsFormat] = useState('mp3');
  const [ttsResult, setTtsResult] = useState<TtsTestResult | null>(null);

  // 3. STT
  const [sttFile, setSttFile] = useState<File | null>(null);
  const [sttModel, setSttModel] = useState('auto');
  const [sttLang, setSttLang] = useState('');
  const [sttResult, setSttResult] = useState<SttTestResult | null>(null);
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 4. Embedding
  const [embInput, setEmbInput] = useState('Semantic vector search with FreeLLMAPI X Gateway.');
  const [embModel, setEmbModel] = useState('auto');
  const [embDim, setEmbDim] = useState<string>('');
  const [embResult, setEmbResult] = useState<EmbeddingTestResult | null>(null);

  // 5. Web Search & Fetch
  const [webQuery, setWebQuery] = useState('What are the latest breakthroughs in AI agents and reasoning models?');
  const [webModel, setWebModel] = useState('auto');
  const [webFetchUrl, setWebFetchUrl] = useState('');
  const [webResult, setWebResult] = useState<WebTestResult | null>(null);
  const [copiedWebResult, setCopiedWebResult] = useState(false);

  // Queries
  const configQuery = useQuery({
    queryKey: ['x-media-config', revision],
    queryFn: ({ signal }) => mediaApi.getConfig(signal),
    staleTime: 30_000,
  });

  const keysQuery = useQuery({
    queryKey: ['x-gateway-keys', revision],
    queryFn: ({ signal }) => apiFetch<{ keys: Array<{ key: string }> }>('/api/x-gateway/keys', { signal }),
    staleTime: 60_000,
  });

  const activeApiKey = keysQuery.data?.keys?.[0]?.key || 'sk-xgw-your-key-here';

  // Mutation for saving defaults
  const saveDefaultsMutation = useMutation({
    mutationFn: (data: MediaDefaults) => mediaApi.saveConfig(data),
    onSuccess: async () => {
      setConfigDraft(null);
      await client.invalidateQueries({ queryKey: ['x-media-config'] });
    },
  });

  // Playground Mutations
  const imageMutation = useMutation({
    mutationFn: () => mediaApi.testImage({ prompt: imagePrompt, model: imageModel, size: imageSize }),
    onSuccess: (res) => setImageResult(res),
  });

  const ttsMutation = useMutation({
    mutationFn: () => mediaApi.testTts({ input: ttsInput, model: ttsModel, voice: ttsVoice, speed: ttsSpeed, response_format: ttsFormat }),
    onSuccess: (res) => setTtsResult(res),
  });

  const sttMutation = useMutation({
    mutationFn: () => {
      if (!sttFile) throw new Error('Please select an audio file first');
      const form = new FormData();
      form.append('file', sttFile);
      if (sttModel && sttModel !== 'auto') form.append('model', sttModel);
      if (sttLang.trim()) form.append('language', sttLang.trim());
      return mediaApi.testStt(form);
    },
    onSuccess: (res) => setSttResult(res),
  });

  const embMutation = useMutation({
    mutationFn: () => {
      const dim = embDim ? parseInt(embDim, 10) : undefined;
      return mediaApi.testEmbedding({ input: embInput, model: embModel, dimensions: dim });
    },
    onSuccess: (res) => setEmbResult(res),
  });

  const webMutation = useMutation({
    mutationFn: () => mediaApi.testWeb({ query: webQuery, model: webModel, fetchUrl: webFetchUrl.trim() || undefined }),
    onSuccess: (res) => setWebResult(res),
  });

  const config = configQuery.data;
  const currentDefaults = configDraft || config?.defaults || {};
  const currentKindSpec = config?.kinds?.[activeKind];

  const updateDraft = (patch: Partial<MediaDefaults>) => {
    setConfigDraft({ ...currentDefaults, ...patch });
  };

  // Unique accessible IDs for form controls
  const imagePromptId = useId();
  const imageModelId = useId();
  const imageSizeId = useId();
  const ttsInputId = useId();
  const ttsModelId = useId();
  const ttsVoiceId = useId();
  const ttsSpeedId = useId();
  const ttsFormatId = useId();
  const sttFileId = useId();
  const sttModelId = useId();
  const sttLangId = useId();
  const embInputId = useId();
  const embModelId = useId();
  const embDimId = useId();
  const webQueryId = useId();
  const webModelId = useId();
  const webFetchUrlId = useId();
  const defImgModelId = useId();
  const defTtsModelId = useId();
  const defTtsVoiceId = useId();
  const defTtsFormatId = useId();
  const defSttModelId = useId();
  const defSttLangId = useId();
  const defEmbModelId = useId();
  const defEmbDimId = useId();
  const defWebModelId = useId();

  // Snippet generator
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const getSnippet = () => {
    const endpointPath = currentKindSpec?.endpoint || `/x/v1/${activeKind}`;
    const url = `${origin}${endpointPath}`;

    if (activeKind === 'image') {
      if (snippetTab === 'curl') {
        return `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${activeApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "A futuristic cityscape at sunset",
    "model": "${imageModel === 'auto' ? (currentDefaults.image?.defaultModel || 'auto') : imageModel}",
    "size": "${imageSize}",
    "n": 1
  }'`;
      }
      if (snippetTab === 'python') {
        return `from openai import OpenAI

client = OpenAI(
    api_key="${activeApiKey}",
    base_url="${origin}/x/v1"
)

response = client.images.generate(
    model="${imageModel === 'auto' ? (currentDefaults.image?.defaultModel || 'auto') : imageModel}",
    prompt="A futuristic cityscape at sunset",
    size="${imageSize}",
    n=1
)
print(response.data[0].url)`;
      }
      return `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${activeApiKey}",
  baseURL: "${origin}/x/v1",
});

const response = await client.images.generate({
  model: "${imageModel === 'auto' ? (currentDefaults.image?.defaultModel || 'auto') : imageModel}",
  prompt: "A futuristic cityscape at sunset",
  size: "${imageSize}",
});
console.log(response.data[0].url);`;
    }

    if (activeKind === 'tts') {
      if (snippetTab === 'curl') {
        return `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${activeApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${ttsModel === 'auto' ? (currentDefaults.tts?.defaultModel || 'auto') : ttsModel}",
    "input": "Hello world from FreeLLMAPI X Gateway!",
    "voice": "${ttsVoice}",
    "response_format": "${ttsFormat}"
  }' --output speech.${ttsFormat}`;
      }
      if (snippetTab === 'python') {
        return `from openai import OpenAI

client = OpenAI(
    api_key="${activeApiKey}",
    base_url="${origin}/x/v1"
)

response = client.audio.speech.create(
    model="${ttsModel === 'auto' ? (currentDefaults.tts?.defaultModel || 'auto') : ttsModel}",
    voice="${ttsVoice}",
    input="Hello world from FreeLLMAPI X Gateway!"
)
response.stream_to_file("output.mp3")`;
      }
      return `import OpenAI from "openai";
import fs from "fs";

const client = new OpenAI({
  apiKey: "${activeApiKey}",
  baseURL: "${origin}/x/v1",
});

const mp3 = await client.audio.speech.create({
  model: "${ttsModel === 'auto' ? (currentDefaults.tts?.defaultModel || 'auto') : ttsModel}",
  voice: "${ttsVoice}",
  input: "Hello world from FreeLLMAPI X Gateway!",
});
const buffer = Buffer.from(await mp3.arrayBuffer());
await fs.promises.writeFile("output.mp3", buffer);`;
    }

    if (activeKind === 'stt') {
      if (snippetTab === 'curl') {
        return `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${activeApiKey}" \\
  -F "file=@audio.mp3" \\
  -F "model=${sttModel === 'auto' ? (currentDefaults.stt?.defaultModel || 'auto') : sttModel}"`;
      }
      if (snippetTab === 'python') {
        return `from openai import OpenAI

client = OpenAI(
    api_key="${activeApiKey}",
    base_url="${origin}/x/v1"
)

with open("audio.mp3", "rb") as audio_file:
    transcript = client.audio.transcriptions.create(
        model="${sttModel === 'auto' ? (currentDefaults.stt?.defaultModel || 'auto') : sttModel}",
        file=audio_file
    )
print(transcript.text)`;
      }
      return `import OpenAI from "openai";
import fs from "fs";

const client = new OpenAI({
  apiKey: "${activeApiKey}",
  baseURL: "${origin}/x/v1",
});

const transcript = await client.audio.transcriptions.create({
  file: fs.createReadStream("audio.mp3"),
  model: "${sttModel === 'auto' ? (currentDefaults.stt?.defaultModel || 'auto') : sttModel}",
});
console.log(transcript.text);`;
    }

    // Embedding
    if (activeKind === 'embedding') {
      if (snippetTab === 'curl') {
        return `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${activeApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${embModel === 'auto' ? (currentDefaults.embedding?.defaultModel || 'auto') : embModel}",
    "input": "Semantic search retrieval test"${embDim ? `, "dimensions": ${embDim}` : ''}
  }'`;
      }
      if (snippetTab === 'python') {
        return `from openai import OpenAI

client = OpenAI(
    api_key="${activeApiKey}",
    base_url="${origin}/x/v1"
)

response = client.embeddings.create(
    model="${embModel === 'auto' ? (currentDefaults.embedding?.defaultModel || 'auto') : embModel}",
    input="Semantic search retrieval test"${embDim ? `, dimensions=${embDim}` : ''}
)
print("Vector length:", len(response.data[0].embedding))`;
      }
      return `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${activeApiKey}",
  baseURL: "${origin}/x/v1",
});

const response = await client.embeddings.create({
  model: "${embModel === 'auto' ? (currentDefaults.embedding?.defaultModel || 'auto') : embModel}",
  input: "Semantic search retrieval test"${embDim ? `, dimensions: ${embDim}` : ''},
});
console.log("Vector length:", response.data[0].embedding.length);`;
    }

    // Web Search & Fetch
    const webModelToUse = webModel === 'auto' ? (currentDefaults.web?.defaultModel || 'sonar-pro') : webModel;
    if (snippetTab === 'curl') {
      return `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${activeApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${webModelToUse}",
    "messages": [
      {"role": "user", "content": ${JSON.stringify(webQuery)}}
    ]
  }'`;
    }
    if (snippetTab === 'python') {
      return `from openai import OpenAI

client = OpenAI(
    api_key="${activeApiKey}",
    base_url="${origin}/x/v1"
)

response = client.chat.completions.create(
    model="${webModelToUse}",
    messages=[
        {"role": "user", "content": ${JSON.stringify(webQuery)}}
    ]
)
print(response.choices[0].message.content)`;
    }
    return `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${activeApiKey}",
  baseURL: "${origin}/x/v1",
});

const response = await client.chat.completions.create({
  model: "${webModelToUse}",
  messages: [
    { role: "user", content: ${JSON.stringify(webQuery)} }
  ],
});
console.log(response.choices[0].message.content);`;
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  return (
    <>
      <div className="x-page-heading">
        <div>
          <h1>{s.mediaTitle}</h1>
          <p>{s.mediaSubtitle}</p>
        </div>
        <span className="x-heading-icon">
          <Film size={28} />
        </span>
      </div>

      {/* Tabs */}
      <div className="x-media-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeKind === 'image'}
          className={`x-media-tab ${activeKind === 'image' ? 'active' : ''}`}
          onClick={() => setActiveKind('image')}
        >
          <Palette size={18} />
          <span>{s.tabImage}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeKind === 'tts'}
          className={`x-media-tab ${activeKind === 'tts' ? 'active' : ''}`}
          onClick={() => setActiveKind('tts')}
        >
          <Volume2 size={18} />
          <span>{s.tabTts}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeKind === 'stt'}
          className={`x-media-tab ${activeKind === 'stt' ? 'active' : ''}`}
          onClick={() => setActiveKind('stt')}
        >
          <Mic size={18} />
          <span>{s.tabStt}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeKind === 'embedding'}
          className={`x-media-tab ${activeKind === 'embedding' ? 'active' : ''}`}
          onClick={() => setActiveKind('embedding')}
        >
          <Binary size={18} />
          <span>{s.tabEmbedding}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeKind === 'web'}
          className={`x-media-tab ${activeKind === 'web' ? 'active' : ''}`}
          onClick={() => setActiveKind('web')}
        >
          <Globe size={18} />
          <span>{s.tabWeb}</span>
        </button>
      </div>

      {/* Kind Header & Endpoint Badge */}
      <div className="x-media-kind-header">
        <div className="x-media-kind-title">
          <h2>{currentKindSpec?.label || activeKind}</h2>
          <span className="x-media-endpoint-badge">
            <code>POST {currentKindSpec?.endpoint}</code>
          </span>
        </div>
      </div>

      {/* 1. Defaults Configuration Card */}
      <section className="x-panel x-media-section">
        <div className="x-media-section-head">
          <div>
            <h3>{s.configTitle}</h3>
            <p className="x-caption">{s.configSubtitle}</p>
          </div>
          {canEdit && (
            <button
              className="x-button x-primary"
              disabled={saveDefaultsMutation.isPending || !configDraft}
              onClick={() => configDraft && saveDefaultsMutation.mutate(configDraft)}
            >
              <Save size={15} />
              {saveDefaultsMutation.isPending ? s.savingConfig : s.saveConfig}
            </button>
          )}
        </div>

        {saveDefaultsMutation.isSuccess && (
          <p className="x-test-ok">{s.configSaved}</p>
        )}

        <div className="x-media-config-grid">
          {activeKind === 'image' && (
            <div className="x-media-field">
              <label htmlFor={defImgModelId}>{s.defaultModel}</label>
              <input
                id={defImgModelId}
                value={currentDefaults.image?.defaultModel ?? 'auto'}
                placeholder={s.customModelPlaceholder}
                disabled={!canEdit}
                onChange={(e) => updateDraft({ image: { ...currentDefaults.image, defaultModel: e.target.value } })}
              />
              <div className="x-media-suggestions">
                {currentKindSpec?.suggestedModels?.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="x-badge-button"
                    onClick={() => updateDraft({ image: { ...currentDefaults.image, defaultModel: m } })}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeKind === 'tts' && (
            <>
              <div className="x-media-field">
                <label htmlFor={defTtsModelId}>{s.defaultModel}</label>
                <input
                  id={defTtsModelId}
                  value={currentDefaults.tts?.defaultModel ?? 'auto'}
                  placeholder={s.customModelPlaceholder}
                  disabled={!canEdit}
                  onChange={(e) => updateDraft({ tts: { ...currentDefaults.tts, defaultModel: e.target.value } })}
                />
                <div className="x-media-suggestions">
                  {currentKindSpec?.suggestedModels?.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="x-badge-button"
                      onClick={() => updateDraft({ tts: { ...currentDefaults.tts, defaultModel: m } })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div className="x-media-field">
                <label htmlFor={defTtsVoiceId}>{s.voice}</label>
                <select
                  id={defTtsVoiceId}
                  value={currentDefaults.tts?.defaultVoice ?? 'alloy'}
                  disabled={!canEdit}
                  onChange={(e) => updateDraft({ tts: { ...currentDefaults.tts, defaultVoice: e.target.value } })}
                >
                  {currentKindSpec?.voices?.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>

              <div className="x-media-field">
                <label htmlFor={defTtsFormatId}>{s.format}</label>
                <select
                  id={defTtsFormatId}
                  value={currentDefaults.tts?.defaultFormat ?? 'mp3'}
                  disabled={!canEdit}
                  onChange={(e) => updateDraft({ tts: { ...currentDefaults.tts, defaultFormat: e.target.value } })}
                >
                  {currentKindSpec?.formats?.map((f) => (
                    <option key={f} value={f}>{f.toUpperCase()}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {activeKind === 'stt' && (
            <>
              <div className="x-media-field">
                <label htmlFor={defSttModelId}>{s.defaultModel}</label>
                <input
                  id={defSttModelId}
                  value={currentDefaults.stt?.defaultModel ?? 'auto'}
                  placeholder={s.customModelPlaceholder}
                  disabled={!canEdit}
                  onChange={(e) => updateDraft({ stt: { ...currentDefaults.stt, defaultModel: e.target.value } })}
                />
                <div className="x-media-suggestions">
                  {currentKindSpec?.suggestedModels?.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="x-badge-button"
                      onClick={() => updateDraft({ stt: { ...currentDefaults.stt, defaultModel: m } })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div className="x-media-field">
                <label htmlFor={defSttLangId}>{s.language}</label>
                <input
                  id={defSttLangId}
                  value={currentDefaults.stt?.defaultLanguage ?? ''}
                  placeholder={s.languagePlaceholder}
                  disabled={!canEdit}
                  onChange={(e) => updateDraft({ stt: { ...currentDefaults.stt, defaultLanguage: e.target.value } })}
                />
              </div>
            </>
          )}

          {activeKind === 'embedding' && (
            <>
              <div className="x-media-field">
                <label htmlFor={defEmbModelId}>{s.defaultModel}</label>
                <input
                  id={defEmbModelId}
                  value={currentDefaults.embedding?.defaultModel ?? 'auto'}
                  placeholder={s.customModelPlaceholder}
                  disabled={!canEdit}
                  onChange={(e) => updateDraft({ embedding: { ...currentDefaults.embedding, defaultModel: e.target.value } })}
                />
                <div className="x-media-suggestions">
                  {currentKindSpec?.suggestedModels?.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="x-badge-button"
                      onClick={() => updateDraft({ embedding: { ...currentDefaults.embedding, defaultModel: m } })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div className="x-media-field">
                <label htmlFor={defEmbDimId}>{s.dimensions}</label>
                <input
                  id={defEmbDimId}
                  type="number"
                  value={currentDefaults.embedding?.defaultDimensions ?? ''}
                  placeholder="e.g. 1536"
                  disabled={!canEdit}
                  onChange={(e) => updateDraft({
                    embedding: {
                      ...currentDefaults.embedding,
                      defaultDimensions: e.target.value ? parseInt(e.target.value, 10) : null,
                    },
                  })}
                />
              </div>
            </>
          )}

          {activeKind === 'web' && (
            <div className="x-media-field">
              <label htmlFor={defWebModelId}>{s.defaultModel}</label>
              <input
                id={defWebModelId}
                value={currentDefaults.web?.defaultModel ?? 'auto'}
                placeholder={s.customModelPlaceholder}
                disabled={!canEdit}
                onChange={(e) => updateDraft({ web: { ...currentDefaults.web, defaultModel: e.target.value } })}
              />
              <div className="x-media-suggestions">
                {currentKindSpec?.suggestedModels?.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="x-badge-button"
                    onClick={() => updateDraft({ web: { ...currentDefaults.web, defaultModel: m } })}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 2. Interactive Tester & Playground Card */}
      <section className="x-panel x-media-section">
        <div className="x-media-section-head">
          <div>
            <h3>{s.testTitle}</h3>
            <p className="x-caption">{s.testSubtitle}</p>
          </div>
        </div>

        {/* --- Image Playground --- */}
        {activeKind === 'image' && (
          <div className="x-playground-grid">
            <div className="x-playground-controls">
              <div className="x-media-field">
                <label htmlFor={imagePromptId}>{s.prompt}</label>
                <textarea
                  id={imagePromptId}
                  rows={3}
                  value={imagePrompt}
                  placeholder={s.imagePromptPlaceholder}
                  onChange={(e) => setImagePrompt(e.target.value)}
                />
              </div>

              <div className="x-media-row">
                <div className="x-media-field">
                  <label htmlFor={imageModelId}>{s.model}</label>
                  <input
                    id={imageModelId}
                    value={imageModel}
                    placeholder="auto, or provider/model"
                    onChange={(e) => setImageModel(e.target.value)}
                  />
                </div>
                <div className="x-media-field">
                  <label htmlFor={imageSizeId}>{s.size}</label>
                  <select
                    id={imageSizeId}
                    value={imageSize}
                    onChange={(e) => setImageSize(e.target.value)}
                  >
                    <option value="1024x1024">1024 x 1024</option>
                    <option value="512x512">512 x 512</option>
                    <option value="256x256">256 x 256</option>
                    <option value="1792x1024">1792 x 1024 (Landscape)</option>
                    <option value="1024x1792">1024 x 1792 (Portrait)</option>
                  </select>
                </div>
              </div>

              <button
                className="x-button x-primary"
                disabled={imageMutation.isPending || !imagePrompt.trim()}
                onClick={() => imageMutation.mutate()}
              >
                <Wand2 size={16} />
                {imageMutation.isPending ? s.generating : s.generateImage}
              </button>

              {imageMutation.isError && (
                <div role="alert" className="x-error">
                  {imageMutation.error.message}
                </div>
              )}
            </div>

            <div className="x-playground-preview">
              {imageResult && (
                <div className="x-image-result-box">
                  <div className="x-result-meta">
                    <span>{s.routedVia}: <strong>{imageResult.provider}/{imageResult.model}</strong></span>
                    <span>{s.latency}: <strong>{imageResult.latencyMs} ms</strong></span>
                  </div>
                  <div className="x-image-gallery">
                    {imageResult.data.map((item, idx) => {
                      const src = item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
                      return (
                        <div key={idx} className="x-image-item">
                          {src ? (
                            <>
                              <img src={src} alt="Generated" />
                              <a
                                href={src}
                                download={`generated-${idx}.png`}
                                target="_blank"
                                rel="noreferrer"
                                className="x-button x-image-download"
                              >
                                <Download size={14} />
                                {s.downloadImage}
                              </a>
                            </>
                          ) : (
                            <pre>{JSON.stringify(item, null, 2)}</pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {!imageResult && !imageMutation.isPending && (
                <div className="x-preview-placeholder">
                  <ImageIcon size={40} />
                  <p>{s.imagePromptPlaceholder}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* --- TTS Playground --- */}
        {activeKind === 'tts' && (
          <div className="x-playground-grid">
            <div className="x-playground-controls">
              <div className="x-media-field">
                <label htmlFor={ttsInputId}>{s.textToSpeak}</label>
                <textarea
                  id={ttsInputId}
                  rows={3}
                  value={ttsInput}
                  placeholder={s.ttsPromptPlaceholder}
                  onChange={(e) => setTtsInput(e.target.value)}
                />
              </div>

              <div className="x-media-row">
                <div className="x-media-field">
                  <label htmlFor={ttsModelId}>{s.model}</label>
                  <input
                    id={ttsModelId}
                    value={ttsModel}
                    placeholder="auto, or provider/model"
                    onChange={(e) => setTtsModel(e.target.value)}
                  />
                </div>
                <div className="x-media-field">
                  <label htmlFor={ttsVoiceId}>{s.voice}</label>
                  <select
                    id={ttsVoiceId}
                    value={ttsVoice}
                    onChange={(e) => setTtsVoice(e.target.value)}
                  >
                    {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="x-media-row">
                <div className="x-media-field">
                  <label htmlFor={ttsSpeedId}>{s.speed}: {ttsSpeed}x</label>
                  <input
                    id={ttsSpeedId}
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={ttsSpeed}
                    onChange={(e) => setTtsSpeed(parseFloat(e.target.value))}
                  />
                </div>
                <div className="x-media-field">
                  <label htmlFor={ttsFormatId}>{s.format}</label>
                  <select
                    id={ttsFormatId}
                    value={ttsFormat}
                    onChange={(e) => setTtsFormat(e.target.value)}
                  >
                    {['mp3', 'opus', 'aac', 'flac', 'wav'].map((f) => (
                      <option key={f} value={f}>{f.toUpperCase()}</option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                className="x-button x-primary"
                disabled={ttsMutation.isPending || !ttsInput.trim()}
                onClick={() => ttsMutation.mutate()}
              >
                <Volume2 size={16} />
                {ttsMutation.isPending ? s.synthesizing : s.synthesizeSpeech}
              </button>

              {ttsMutation.isError && (
                <div role="alert" className="x-error">
                  {ttsMutation.error.message}
                </div>
              )}
            </div>

            <div className="x-playground-preview">
              {ttsResult && (
                <div className="x-audio-result-box">
                  <div className="x-result-meta">
                    <span>{s.routedVia}: <strong>{ttsResult.provider}/{ttsResult.model}</strong></span>
                    <span>{s.latency}: <strong>{ttsResult.latencyMs} ms</strong></span>
                  </div>
                  <div className="x-audio-player-wrap">
                    <audio
                      controls
                      autoPlay
                      src={`data:${ttsResult.contentType};base64,${ttsResult.audioBase64}`}
                    />
                    <a
                      href={`data:${ttsResult.contentType};base64,${ttsResult.audioBase64}`}
                      download={`speech.${ttsFormat}`}
                      className="x-button"
                    >
                      <Download size={14} />
                      {s.downloadAudio}
                    </a>
                  </div>
                </div>
              )}
              {!ttsResult && !ttsMutation.isPending && (
                <div className="x-preview-placeholder">
                  <Volume2 size={40} />
                  <p>{s.ttsPromptPlaceholder}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* --- STT Playground --- */}
        {activeKind === 'stt' && (
          <div className="x-playground-grid">
            <div className="x-playground-controls">
              <div className="x-media-field">
                <label htmlFor={sttFileId}>{s.audioFile}</label>
                <div
                  className="x-dropzone"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <UploadCloud size={28} />
                  <p>{sttFile ? sttFile.name : s.uploadAudioPrompt}</p>
                  <input
                    id={sttFileId}
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files?.[0]) setSttFile(e.target.files[0]);
                    }}
                  />
                </div>
              </div>

              <div className="x-media-row">
                <div className="x-media-field">
                  <label htmlFor={sttModelId}>{s.model}</label>
                  <input
                    id={sttModelId}
                    value={sttModel}
                    placeholder="auto, or provider/model"
                    onChange={(e) => setSttModel(e.target.value)}
                  />
                </div>
                <div className="x-media-field">
                  <label htmlFor={sttLangId}>{s.language}</label>
                  <input
                    id={sttLangId}
                    value={sttLang}
                    placeholder="e.g. en, vi, ja"
                    onChange={(e) => setSttLang(e.target.value)}
                  />
                </div>
              </div>

              <button
                className="x-button x-primary"
                disabled={sttMutation.isPending || !sttFile}
                onClick={() => sttMutation.mutate()}
              >
                <Mic size={16} />
                {sttMutation.isPending ? s.transcribing : s.transcribe}
              </button>

              {sttMutation.isError && (
                <div role="alert" className="x-error">
                  {sttMutation.error.message}
                </div>
              )}
            </div>

            <div className="x-playground-preview">
              {sttResult && (
                <div className="x-transcript-result-box">
                  <div className="x-result-meta">
                    <span>{s.routedVia}: <strong>{sttResult.provider}/{sttResult.model}</strong></span>
                    <span>{s.latency}: <strong>{sttResult.latencyMs} ms</strong></span>
                  </div>
                  <div className="x-transcript-content">
                    <p>{sttResult.text}</p>
                    <button
                      className="x-button"
                      onClick={() => {
                        navigator.clipboard.writeText(sttResult.text);
                        setCopiedTranscript(true);
                        setTimeout(() => setCopiedTranscript(false), 2000);
                      }}
                    >
                      {copiedTranscript ? <Check size={14} /> : <Copy size={14} />}
                      {copiedTranscript ? s.copied : s.copyTranscript}
                    </button>
                  </div>
                </div>
              )}
              {!sttResult && !sttMutation.isPending && (
                <div className="x-preview-placeholder">
                  <Mic size={40} />
                  <p>{s.uploadAudioPrompt}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* --- Embedding Playground --- */}
        {activeKind === 'embedding' && (
          <div className="x-playground-grid">
            <div className="x-playground-controls">
              <div className="x-media-field">
                <label htmlFor={embInputId}>{s.embeddingText}</label>
                <textarea
                  id={embInputId}
                  rows={3}
                  value={embInput}
                  placeholder={s.embeddingPlaceholder}
                  onChange={(e) => setEmbInput(e.target.value)}
                />
              </div>

              <div className="x-media-row">
                <div className="x-media-field">
                  <label htmlFor={embModelId}>{s.model}</label>
                  <input
                    id={embModelId}
                    value={embModel}
                    placeholder="auto, or provider/model"
                    onChange={(e) => setEmbModel(e.target.value)}
                  />
                </div>
                <div className="x-media-field">
                  <label htmlFor={embDimId}>{s.dimensions}</label>
                  <input
                    id={embDimId}
                    type="number"
                    value={embDim}
                    placeholder="e.g. 1536"
                    onChange={(e) => setEmbDim(e.target.value)}
                  />
                </div>
              </div>

              <button
                className="x-button x-primary"
                disabled={embMutation.isPending || !embInput.trim()}
                onClick={() => embMutation.mutate()}
              >
                <Binary size={16} />
                {embMutation.isPending ? s.computing : s.computeEmbedding}
              </button>

              {embMutation.isError && (
                <div role="alert" className="x-error">
                  {embMutation.error.message}
                </div>
              )}
            </div>

            <div className="x-playground-preview">
              {embResult && (
                <div className="x-emb-result-box">
                  <div className="x-result-meta">
                    <span>{s.routedVia}: <strong>{embResult.provider}/{embResult.model}</strong></span>
                    <span>{s.latency}: <strong>{embResult.latencyMs} ms</strong></span>
                  </div>
                  <div className="x-emb-stats">
                    <span className="x-emb-badge">
                      {s.dimensionsCount}: <strong>{embResult.dimensions}</strong>
                    </span>
                    {embResult.usage && (
                      <span className="x-emb-badge">
                        {s.totalTokens}: <strong>{embResult.usage.total_tokens || embResult.usage.prompt_tokens}</strong>
                      </span>
                    )}
                  </div>
                  <div className="x-emb-sample">
                    <label>{s.sampleVector}</label>
                    <pre>
                      [{embResult.embeddingSample.map((v) => v.toFixed(6)).join(', ')}, ...]
                    </pre>
                  </div>
                </div>
              )}
              {!embResult && !embMutation.isPending && (
                <div className="x-preview-placeholder">
                  <Binary size={40} />
                  <p>{s.embeddingPlaceholder}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* --- Web Search & Fetch Playground --- */}
        {activeKind === 'web' && (
          <div className="x-playground-grid">
            <div className="x-playground-controls">
              <div className="x-media-field">
                <label htmlFor={webQueryId}>{s.webQuery}</label>
                <textarea
                  id={webQueryId}
                  rows={3}
                  value={webQuery}
                  placeholder={s.webQueryPlaceholder}
                  onChange={(e) => setWebQuery(e.target.value)}
                />
              </div>

              <div className="x-media-row">
                <div className="x-media-field">
                  <label htmlFor={webModelId}>{s.model}</label>
                  <input
                    id={webModelId}
                    value={webModel}
                    placeholder="auto, sonar-pro, or provider/model"
                    onChange={(e) => setWebModel(e.target.value)}
                  />
                </div>
                <div className="x-media-field">
                  <label htmlFor={webFetchUrlId}>{s.fetchUrl}</label>
                  <input
                    id={webFetchUrlId}
                    value={webFetchUrl}
                    placeholder={s.fetchUrlPlaceholder}
                    onChange={(e) => setWebFetchUrl(e.target.value)}
                  />
                </div>
              </div>

              <button
                className="x-button x-primary"
                disabled={webMutation.isPending || !webQuery.trim()}
                onClick={() => webMutation.mutate()}
              >
                <Globe size={16} />
                {webMutation.isPending ? s.searchingWeb : s.searchWeb}
              </button>

              {webMutation.isError && (
                <div role="alert" className="x-error">
                  {webMutation.error.message}
                </div>
              )}
            </div>

            <div className="x-playground-preview">
              {webResult && (
                <div className="x-emb-result-box" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div className="x-result-meta">
                    <span>{s.routedVia}: <strong>{webResult.provider}/{webResult.model}</strong></span>
                    <span>{s.latency}: <strong>{webResult.latencyMs} ms</strong></span>
                  </div>
                  <div style={{
                    background: 'var(--bg-subtle, rgba(0,0,0,0.04))',
                    padding: '0.75rem',
                    borderRadius: '8px',
                    fontSize: '0.875rem',
                    lineHeight: '1.5',
                    maxHeight: '260px',
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                  }}>
                    {webResult.content || JSON.stringify(webResult.results, null, 2)}
                  </div>
                  {webResult.results && webResult.results.length > 0 && webResult.results[0].url && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      <span>{s.sources}: </span>
                      <a href={webResult.results[0].url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--link, #3b82f6)' }}>
                        {webResult.results[0].url}
                      </a>
                    </div>
                  )}
                  <div>
                    <button
                      className="x-button"
                      onClick={() => {
                        navigator.clipboard.writeText(webResult.content || JSON.stringify(webResult.results, null, 2));
                        setCopiedWebResult(true);
                        setTimeout(() => setCopiedWebResult(false), 2000);
                      }}
                    >
                      {copiedWebResult ? <Check size={14} /> : <Copy size={14} />}
                      {copiedWebResult ? s.copied : s.copyWebResult}
                    </button>
                  </div>
                </div>
              )}
              {!webResult && !webMutation.isPending && (
                <div className="x-preview-placeholder">
                  <Globe size={40} />
                  <p>{s.webQueryPlaceholder}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* 3. Providers Supporting this Kind */}
      <section className="x-panel x-media-section">
        <div className="x-media-section-head">
          <div>
            <h3>{s.providersTitle} ({currentKindSpec?.providers?.length || 0})</h3>
          </div>
        </div>

        <div className="x-media-providers-grid">
          {currentKindSpec?.providers?.map((p) => (
            <div key={p.id} className={`x-media-provider-card ${p.isConnected ? 'connected' : ''}`}>
              <div className="x-media-provider-card-head">
                <ProviderMark id={p.id} name={p.name} />
                <div>
                  <strong>{p.name}</strong>
                  <div className="x-media-provider-models-badge">
                    {p.isConnected ? (
                      <span className="x-badge-success">{s.connected} ({p.connectedAccounts})</span>
                    ) : (
                      <span className="x-badge-muted">{s.noAccounts}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="x-media-provider-card-actions">
                <Link to={`/x/providers/${encodeURIComponent(p.id)}`} className="x-button x-button-sm">
                  {p.isConnected ? s.ready : s.addAccount}
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 4. API Code Snippets Card */}
      <section className="x-panel x-media-section">
        <div className="x-media-section-head">
          <div>
            <h3>{s.codeSnippetTitle}</h3>
            <p className="x-caption">{s.codeSnippetSubtitle}</p>
          </div>
          <button
            className="x-button"
            onClick={() => handleCopy(getSnippet())}
          >
            {copiedSnippet ? <Check size={14} /> : <Copy size={14} />}
            {copiedSnippet ? s.copied : s.copySnippet}
          </button>
        </div>

        <div className="x-snippet-tabs">
          <button
            className={`x-snippet-tab ${snippetTab === 'curl' ? 'active' : ''}`}
            onClick={() => setSnippetTab('curl')}
          >
            {s.curlTab}
          </button>
          <button
            className={`x-snippet-tab ${snippetTab === 'python' ? 'active' : ''}`}
            onClick={() => setSnippetTab('python')}
          >
            {s.pythonTab}
          </button>
          <button
            className={`x-snippet-tab ${snippetTab === 'node' ? 'active' : ''}`}
            onClick={() => setSnippetTab('node')}
          >
            {s.nodeTab}
          </button>
        </div>

        <pre className="x-snippet-code">
          <code>{getSnippet()}</code>
        </pre>
      </section>
    </>
  );
}
