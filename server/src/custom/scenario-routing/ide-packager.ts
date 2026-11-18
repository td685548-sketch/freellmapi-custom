import {
  IDE_PACKAGER_TOOLS,
  type IdePackageBundle,
  type IdePackagerToolId,
} from '@freellmapi/shared/scenario-routing.js';

const VALID_IDE_TOOLS = new Set<string>(IDE_PACKAGER_TOOLS);

export function isValidIdeToolId(value: unknown): value is IdePackagerToolId {
  return typeof value === 'string' && VALID_IDE_TOOLS.has(value);
}

export function sanitizeGatewayOrigin(rawUrl: string): string {
  const cleaned = rawUrl
    .trim()
    .replace(/[\r\n\t"'`$\\;]/g, '')
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'http://127.0.0.1:3001';
    }
    const basePath = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
    return `${parsed.origin}${basePath}`;
  } catch {
    return 'http://127.0.0.1:3001';
  }
}

function sanitizeKeyValue(rawKey: string | null | undefined, fallbackPlaceholder: string): {
  keyText: string;
  maskedKey: string;
  hasRawKey: boolean;
} {
  const clean = (rawKey ?? '').trim().replace(/[\r\n\t"'`$\\]/g, '');
  if (!clean) {
    return {
      keyText: fallbackPlaceholder,
      maskedKey: fallbackPlaceholder,
      hasRawKey: false,
    };
  }
  const masked =
    clean.length >= 14
      ? `${clean.slice(0, 10)}${'•'.repeat(10)}${clean.slice(-4)}`
      : `${clean.slice(0, 4)}••••••••`;
  return {
    keyText: clean,
    maskedKey: masked,
    hasRawKey: true,
  };
}

function psSingleQuote(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

function bashSingleQuote(val: string): string {
  return `'${val.replace(/'/g, "'\\''")}'`;
}

export function generateIdePackageBundle(params: {
  toolId: IdePackagerToolId;
  gatewayUrl: string;
  rawApiKey?: string | null;
  keyPrefix?: string | null;
  defaultModel?: string | null;
}): IdePackageBundle {
  const rootOrigin = sanitizeGatewayOrigin(params.gatewayUrl);
  const v1Base = `${rootOrigin}/v1`;
  const model = (params.defaultModel ?? '').trim().replace(/[\r\n\t"'`$\\]/g, '') || 'auto';
  const placeholder = params.keyPrefix
    ? `<paste-full-key-for-${params.keyPrefix.replace(/[\r\n\t"'`$\\]/g, '')}>`
    : '<paste-your-sk-flm-personal-key>';
  const { keyText, maskedKey, hasRawKey } = sanitizeKeyValue(params.rawApiKey, placeholder);

  const verifyPingUrl = `${rootOrigin}/api/scenario-routing/verify-ping`;
  const verifyPowershellSnippet = `$headers = @{ Authorization = "Bearer " + ${psSingleQuote(keyText)} }; Invoke-RestMethod -Method Post -Uri ${psSingleQuote(verifyPingUrl)} -Headers $headers`;
  const verifyBashSnippet = `curl -fsSL -X POST ${bashSingleQuote(verifyPingUrl)} -H "Authorization: Bearer "${bashSingleQuote(keyText)}`;

  switch (params.toolId) {
    case 'claude-code': {
      const settingsJson = JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: rootOrigin,
            ANTHROPIC_AUTH_TOKEN: keyText,
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
          },
        },
        null,
        2,
      );

      const ps = [
        `$dir = Join-Path $HOME ".claude"; New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
        `${psSingleQuote(settingsJson)} | Set-Content -Encoding UTF8 (Join-Path $dir "settings.json")`,
        verifyPowershellSnippet,
      ].join('\n');

      const bash = [
        `mkdir -p ~/.claude`,
        `cat <<'EOF' > ~/.claude/settings.json\n${settingsJson}\nEOF`,
        verifyBashSnippet,
      ].join('\n');

      return {
        toolId: 'claude-code',
        toolName: 'Claude Code',
        protocol: 'Anthropic Messages (/v1/messages)',
        baseUrl: rootOrigin,
        maskedKey,
        hasRawKey,
        files: [
          {
            filename: 'claude-settings.json',
            targetPath: '~/.claude/settings.json',
            format: 'json',
            content: `${settingsJson}\n`,
            descriptionEn: 'Claude Code environment & gateway model discovery configuration',
            descriptionVi: 'Cấu hình môi trường & tự động nhận diện model cho Claude Code',
          },
        ],
        powershellSnippet: ps,
        bashSnippet: bash,
        verifyPowershellSnippet,
        verifyBashSnippet,
        stepsEn: [
          'Run the PowerShell or Bash 1-liner in your terminal (or save ~/.claude/settings.json).',
          'Launch `claude` inside any project folder — Scenario Auto-Routing will automatically offload background title/compaction turns to Eco.',
          'Click "Verify IDE Connection" below to confirm live gateway reachability.',
        ],
        stepsVi: [
          'Chạy lệnh 1 dòng PowerShell hoặc Bash trong terminal (hoặc lưu file ~/.claude/settings.json).',
          'Gõ `claude` trong thư mục dự án — Bộ định tuyến Ngữ cảnh sẽ tự động chuyển các tác vụ nền (đặt tiêu đề, nén ngữ cảnh) sang tầng Eco.',
          'Bấm "Kiểm tra kết nối IDE" bên dưới để xác nhận kết nối trực tiếp.',
        ],
      };
    }

    case 'cursor': {
      const cursorGuide = [
        '# Cursor IDE — FreeLLMAPI Gateway Configuration',
        '',
        `1. Open **Cursor Settings** -> **Models**`,
        `2. Enable **OpenAI API Key** and paste: \`${keyText}\``,
        `3. Enable **Override OpenAI Base URL** and enter: \`${v1Base}\``,
        `4. Add custom model ID: \`${model}\` (routes dynamically via Scenario Auto-Router)`,
        '',
      ].join('\n');

      const cursorProfileJson = JSON.stringify(
        {
          provider: 'OpenAI Compatible (FreeLLMAPI)',
          openAIBaseUrl: v1Base,
          openAIApiKey: keyText,
          recommendedModels: ['auto', 'auto:fastest', 'auto:smartest'],
        },
        null,
        2,
      );

      const ps = [
        `# Set environment variables & verify Gateway connection for Cursor`,
        `$env:OPENAI_BASE_URL = ${psSingleQuote(v1Base)}`,
        `$env:OPENAI_API_KEY = ${psSingleQuote(keyText)}`,
        verifyPowershellSnippet,
      ].join('\n');

      const bash = [
        `export OPENAI_BASE_URL=${bashSingleQuote(v1Base)}`,
        `export OPENAI_API_KEY=${bashSingleQuote(keyText)}`,
        verifyBashSnippet,
      ].join('\n');

      return {
        toolId: 'cursor',
        toolName: 'Cursor',
        protocol: 'OpenAI Chat (/v1/chat/completions)',
        baseUrl: v1Base,
        maskedKey,
        hasRawKey,
        files: [
          {
            filename: 'cursor-freellmapi.json',
            targetPath: 'cursor-freellmapi.json',
            format: 'json',
            content: `${cursorProfileJson}\n`,
            descriptionEn: 'Reference connection bundle for Cursor Models settings',
            descriptionVi: 'Gói thông số kết nối chuẩn cho mục Models trong Cursor',
          },
          {
            filename: 'CURSOR_SETUP.md',
            targetPath: 'CURSOR_SETUP.md',
            format: 'markdown',
            content: cursorGuide,
            descriptionEn: 'Step-by-step Cursor IDE setup checklist',
            descriptionVi: 'Hướng dẫn cài đặt từng bước trên Cursor IDE',
          },
        ],
        powershellSnippet: ps,
        bashSnippet: bash,
        verifyPowershellSnippet,
        verifyBashSnippet,
        stepsEn: [
          `Open Cursor Settings -> Models -> Override OpenAI Base URL -> paste ${v1Base}`,
          'Paste your Personal API Key into OpenAI API Key and add model `auto`.',
          'Click Verify in Cursor or run the verification snippet to see the green indicator light up.',
        ],
        stepsVi: [
          `Mở Cursor Settings -> Models -> bật Override OpenAI Base URL -> dán ${v1Base}`,
          'Dán Personal API Key vào ô OpenAI API Key và thêm model `auto`.',
          'Bấm Verify trong Cursor hoặc chạy lệnh kiểm tra để đèn trạng thái chuyển sang màu xanh.',
        ],
      };
    }

    case 'cline-roo': {
      const clineProvidersJson = JSON.stringify(
        {
          version: 1,
          lastUsedProvider: 'openai-compatible',
          providers: {
            'openai-compatible': {
              settings: {
                provider: 'openai-compatible',
                protocol: 'openai-chat',
                client: 'openai-compatible',
                model,
                baseUrl: v1Base,
                apiKey: keyText,
                contextWindow: 128000,
                capabilities: ['streaming', 'tools'],
              },
              updatedAt: '2026-11-18T00:00:00.000Z',
              tokenSource: 'manual',
            },
          },
        },
        null,
        2,
      );

      const rooImportJson = JSON.stringify(
        {
          providerProfiles: {
            currentApiConfigName: 'freellmapi',
            apiConfigs: {
              freellmapi: {
                apiProvider: 'openai',
                openAiBaseUrl: v1Base,
                openAiApiKey: keyText,
                openAiModelId: model,
                openAiStreamingEnabled: true,
                openAiCustomModelInfo: {
                  contextWindow: 128000,
                  maxTokens: 8192,
                  supportsPromptCache: false,
                },
              },
            },
          },
          globalSettings: {},
        },
        null,
        2,
      );

      const ps = [
        `$clineDir = Join-Path $HOME ".cline\\data\\settings"; New-Item -ItemType Directory -Force -Path $clineDir | Out-Null`,
        `${psSingleQuote(clineProvidersJson)} | Set-Content -Encoding UTF8 (Join-Path $clineDir "providers.json")`,
        `$rooDir = Join-Path $HOME ".roo"; New-Item -ItemType Directory -Force -Path $rooDir | Out-Null`,
        `${psSingleQuote(rooImportJson)} | Set-Content -Encoding UTF8 (Join-Path $rooDir "freellmapi.json")`,
        verifyPowershellSnippet,
      ].join('\n');

      const bash = [
        `mkdir -p ~/.cline/data/settings ~/.roo`,
        `cat <<'EOF' > ~/.cline/data/settings/providers.json\n${clineProvidersJson}\nEOF`,
        `cat <<'EOF' > ~/.roo/freellmapi.json\n${rooImportJson}\nEOF`,
        verifyBashSnippet,
      ].join('\n');

      return {
        toolId: 'cline-roo',
        toolName: 'Cline / Roo Code',
        protocol: 'OpenAI Chat (/v1/chat/completions)',
        baseUrl: v1Base,
        maskedKey,
        hasRawKey,
        files: [
          {
            filename: 'cline-providers.json',
            targetPath: '~/.cline/data/settings/providers.json',
            format: 'json',
            content: `${clineProvidersJson}\n`,
            descriptionEn: 'Cline OpenAI-Compatible provider profile',
            descriptionVi: 'Cấu hình nhà cung cấp OpenAI-Compatible cho Cline',
          },
          {
            filename: 'roo-freellmapi.json',
            targetPath: '~/.roo/freellmapi.json',
            format: 'json',
            content: `${rooImportJson}\n`,
            descriptionEn: 'Roo Code importable settings profile (Settings -> Import)',
            descriptionVi: 'File cấu hình nhập nhanh cho Roo Code (Settings -> Import)',
          },
        ],
        powershellSnippet: ps,
        bashSnippet: bash,
        verifyPowershellSnippet,
        verifyBashSnippet,
        stepsEn: [
          'Run the 1-liner (or download `roo-freellmapi.json` for Roo Code Settings -> Import).',
          `Or in VS Code Cline/Roo Settings: choose "OpenAI Compatible", Base URL \`${v1Base}\`, Model \`${model}\`.`,
          'Send a test message or run the verification snippet to confirm connection.',
        ],
        stepsVi: [
          'Chạy lệnh 1 dòng (hoặc tải `roo-freellmapi.json` để Import trong Roo Code Settings).',
          `Hoặc mở cài đặt Cline/Roo trên VS Code: chọn "OpenAI Compatible", Base URL \`${v1Base}\`, Model \`${model}\`.`,
          'Gửi thử 1 tin nhắn hoặc chạy lệnh kiểm tra để xác nhận kết nối.',
        ],
      };
    }

    case 'codex': {
      const codexToml = [
        '# freellmapi:start',
        `model = ${JSON.stringify(model)}`,
        'model_provider = "freellmapi"',
        'model_context_window = 128000',
        'model_auto_compact_token_limit = 115200',
        'tool_output_token_limit = 20000',
        '',
        '[model_providers.freellmapi]',
        'name = "FreeLLMAPI"',
        `base_url = ${JSON.stringify(v1Base)}`,
        'wire_api = "responses"',
        'env_key = "FREELLMAPI_API_KEY"',
        'requires_openai_auth = false',
        '# freellmapi:end',
        '',
      ].join('\n');

      const ps = [
        `$codexDir = Join-Path $HOME ".codex"; New-Item -ItemType Directory -Force -Path $codexDir | Out-Null`,
        `${psSingleQuote(codexToml)} | Set-Content -Encoding UTF8 (Join-Path $codexDir "config.toml")`,
        `$env:FREELLMAPI_API_KEY = ${psSingleQuote(keyText)}`,
        `[Environment]::SetEnvironmentVariable("FREELLMAPI_API_KEY", ${psSingleQuote(keyText)}, "User")`,
        verifyPowershellSnippet,
      ].join('\n');

      const bash = [
        `mkdir -p ~/.codex`,
        `cat <<'EOF' > ~/.codex/config.toml\n${codexToml}EOF`,
        `export FREELLMAPI_API_KEY=${bashSingleQuote(keyText)}`,
        verifyBashSnippet,
      ].join('\n');

      return {
        toolId: 'codex',
        toolName: 'Codex CLI',
        protocol: 'OpenAI Responses (/v1/responses)',
        baseUrl: v1Base,
        maskedKey,
        hasRawKey,
        files: [
          {
            filename: 'config.toml',
            targetPath: '~/.codex/config.toml',
            format: 'toml',
            content: codexToml,
            descriptionEn: 'Codex CLI Responses-wire provider configuration',
            descriptionVi: 'Cấu hình giao thức Responses chuẩn cho Codex CLI',
          },
        ],
        powershellSnippet: ps,
        bashSnippet: bash,
        verifyPowershellSnippet,
        verifyBashSnippet,
        stepsEn: [
          'Run the setup script to write `~/.codex/config.toml` and set `FREELLMAPI_API_KEY`.',
          'Start `codex` in your project directory (uses `/v1/responses` with scenario routing).',
          'Verify live connection status below.',
        ],
        stepsVi: [
          'Chạy lệnh cài đặt để ghi `~/.codex/config.toml` và đặt biến `FREELLMAPI_API_KEY`.',
          'Gõ `codex` trong thư mục code (chạy qua `/v1/responses` kèm tự động định tuyến ngữ cảnh).',
          'Kiểm tra đèn trạng thái kết nối trực tiếp bên dưới.',
        ],
      };
    }

    case 'opencode': {
      const opencodeJson = JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: `freellmapi/${model}`,
          provider: {
            freellmapi: {
              npm: '@ai-sdk/openai-compatible',
              name: 'FreeLLMAPI',
              options: {
                baseURL: v1Base,
              },
              models: {
                [model]: {
                  name: model === 'auto' ? 'FreeLLMAPI Auto Router' : model,
                  limit: { context: 128000, output: 8192 },
                },
              },
            },
          },
        },
        null,
        2,
      );

      const authJson = JSON.stringify(
        {
          freellmapi: {
            type: 'api',
            key: keyText,
          },
        },
        null,
        2,
      );

      const ps = [
        `$cfgDir = Join-Path $HOME ".config\\opencode"; New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null`,
        `$authDir = Join-Path $HOME ".local\\share\\opencode"; New-Item -ItemType Directory -Force -Path $authDir | Out-Null`,
        `${psSingleQuote(opencodeJson)} | Set-Content -Encoding UTF8 (Join-Path $cfgDir "opencode.json")`,
        `${psSingleQuote(authJson)} | Set-Content -Encoding UTF8 (Join-Path $authDir "auth.json")`,
        verifyPowershellSnippet,
      ].join('\n');

      const bash = [
        `mkdir -p ~/.config/opencode ~/.local/share/opencode`,
        `cat <<'EOF' > ~/.config/opencode/opencode.json\n${opencodeJson}\nEOF`,
        `cat <<'EOF' > ~/.local/share/opencode/auth.json\n${authJson}\nEOF`,
        `chmod 600 ~/.local/share/opencode/auth.json`,
        verifyBashSnippet,
      ].join('\n');

      return {
        toolId: 'opencode',
        toolName: 'OpenCode',
        protocol: 'OpenAI Chat (/v1/chat/completions)',
        baseUrl: v1Base,
        maskedKey,
        hasRawKey,
        files: [
          {
            filename: 'opencode.json',
            targetPath: '~/.config/opencode/opencode.json',
            format: 'json',
            content: `${opencodeJson}\n`,
            descriptionEn: 'OpenCode provider & model configuration',
            descriptionVi: 'Cấu hình provider & model cho OpenCode',
          },
          {
            filename: 'auth.json',
            targetPath: '~/.local/share/opencode/auth.json',
            format: 'json',
            content: `${authJson}\n`,
            descriptionEn: 'OpenCode persistent credential store',
            descriptionVi: 'Kho lưu khóa xác thực tự động cho OpenCode',
          },
        ],
        powershellSnippet: ps,
        bashSnippet: bash,
        verifyPowershellSnippet,
        verifyBashSnippet,
        stepsEn: [
          'Run the PowerShell or Bash setup snippet to write `opencode.json` and `auth.json`.',
          `Run \`opencode\` — \`freellmapi/${model}\` will be active immediately without extra env vars.`,
          'Verify connection status below.',
        ],
        stepsVi: [
          'Chạy lệnh PowerShell hoặc Bash để ghi `opencode.json` và `auth.json`.',
          `Chạy \`opencode\` — model \`freellmapi/${model}\` sẵn sàng ngay không cần biến môi trường phụ.`,
          'Kiểm tra trạng thái kết nối bên dưới.',
        ],
      };
    }

    case 'continue': {
      const continueYaml = [
        '# freellmapi:start',
        'name: FreeLLMAPI',
        'version: 1.0.0',
        'schema: v1',
        'models:',
        '  - name: FreeLLMAPI Auto',
        '    provider: openai',
        `    model: ${JSON.stringify(model)}`,
        `    apiBase: ${JSON.stringify(v1Base)}`,
        '    apiKey: ${{ secrets.FREELLMAPI_API_KEY }}',
        '    capabilities:',
        '      - tool_use',
        '    defaultCompletionOptions:',
        '      contextLength: 128000',
        '# freellmapi:end',
        '',
      ].join('\n');

      const continueEnv = `FREELLMAPI_API_KEY=${keyText}\n`;

      const ps = [
        `$contDir = Join-Path $HOME ".continue"; New-Item -ItemType Directory -Force -Path $contDir | Out-Null`,
        `${psSingleQuote(continueYaml)} | Set-Content -Encoding UTF8 (Join-Path $contDir "config.yaml")`,
        `${psSingleQuote(continueEnv)} | Set-Content -Encoding UTF8 (Join-Path $contDir ".env")`,
        verifyPowershellSnippet,
      ].join('\n');

      const bash = [
        `mkdir -p ~/.continue`,
        `cat <<'EOF' > ~/.continue/config.yaml\n${continueYaml}EOF`,
        `cat <<'EOF' > ~/.continue/.env\n${continueEnv}EOF`,
        `chmod 600 ~/.continue/.env`,
        verifyBashSnippet,
      ].join('\n');

      return {
        toolId: 'continue',
        toolName: 'Continue',
        protocol: 'OpenAI Chat (/v1/chat/completions)',
        baseUrl: v1Base,
        maskedKey,
        hasRawKey,
        files: [
          {
            filename: 'config.yaml',
            targetPath: '~/.continue/config.yaml',
            format: 'yaml',
            content: continueYaml,
            descriptionEn: 'Continue v1 config referencing secret key',
            descriptionVi: 'Cấu hình Continue v1 tham chiếu khóa bảo mật',
          },
          {
            filename: '.env',
            targetPath: '~/.continue/.env',
            format: 'env',
            content: continueEnv,
            descriptionEn: 'Continue local secret file read by VS Code & JetBrains extensions',
            descriptionVi: 'File khóa bảo mật cục bộ cho extension VS Code & JetBrains',
          },
        ],
        powershellSnippet: ps,
        bashSnippet: bash,
        verifyPowershellSnippet,
        verifyBashSnippet,
        stepsEn: [
          'Run the PowerShell or Bash command to create `~/.continue/config.yaml` and `~/.continue/.env`.',
          'Reload Continue in VS Code or JetBrains and select "FreeLLMAPI Auto".',
          'Click "Verify IDE Connection" to confirm live traffic.',
        ],
        stepsVi: [
          'Chạy lệnh PowerShell hoặc Bash để tạo `~/.continue/config.yaml` và `~/.continue/.env`.',
          'Tải lại extension Continue trên VS Code hoặc JetBrains và chọn "FreeLLMAPI Auto".',
          'Bấm "Kiểm tra kết nối IDE" để xác nhận trạng thái hoạt động.',
        ],
      };
    }
  }
}
