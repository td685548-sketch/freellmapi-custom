export interface ModelAlias {
  alias: string;
  targetModel: string;
  desc?: string;
}

export interface SetupStep {
  title: string;
  desc: string;
  codeSnippet?: string;
}

export interface ConfigFileInfo {
  filename: string;
  pathDesc: string;
  format: 'json' | 'toml' | 'yaml';
  generate: (opts: { baseUrl: string; apiKey: string }) => string;
}

export interface CliTool {
  id: string;
  name: string;
  category: 'cli' | 'ide' | 'agent';
  image: string;
  badge: string;
  tagline: string;
  docsUrl: string;
  protocol: string;
  envVars: {
    baseUrlKey: string;
    apiKeyKey: string;
    modelKey?: string;
    extra?: Record<string, string>;
  };
  aliases?: ModelAlias[];
  configFile?: ConfigFileInfo;
  steps?: SetupStep[];
}

export const CLI_TOOLS_CATALOG: CliTool[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    category: 'cli',
    image: '/providers/claude.png',
    badge: 'Anthropic CLI',
    tagline: 'Anthropic official terminal coding agent for iterative development',
    docsUrl: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview',
    protocol: 'Anthropic Messages (/thruline/v1/messages)',
    envVars: {
      baseUrlKey: 'ANTHROPIC_BASE_URL',
      apiKeyKey: 'ANTHROPIC_API_KEY',
      modelKey: 'ANTHROPIC_MODEL',
      extra: {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'cc/claude-sonnet-4.5',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'cc/claude-opus-4',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'cc/claude-haiku-4.5',
      },
    },
    aliases: [
      { alias: 'sonnet', targetModel: 'cc/claude-sonnet-4.5', desc: 'Fast, highly-capable daily coding' },
      { alias: 'opus', targetModel: 'cc/claude-opus-4', desc: 'Deep architectural reasoning' },
      { alias: 'haiku', targetModel: 'cc/claude-haiku-4.5', desc: 'Ultra-fast sub-task execution' },
      { alias: 'default', targetModel: 'auto', desc: 'Smart fallback routing' },
    ],
    configFile: {
      filename: 'settings.json',
      pathDesc: '~/.claude/settings.json',
      format: 'json',
      generate: ({ baseUrl, apiKey }) =>
        JSON.stringify(
          {
            env: {
              ANTHROPIC_BASE_URL: baseUrl,
              ANTHROPIC_API_KEY: apiKey,
              ANTHROPIC_DEFAULT_SONNET_MODEL: 'cc/claude-sonnet-4.5',
              ANTHROPIC_DEFAULT_OPUS_MODEL: 'cc/claude-opus-4',
            },
          },
          null,
          2
        ),
    },
    steps: [
      {
        title: 'Install Claude Code globally',
        desc: 'If not already installed, install using npm or npx:',
        codeSnippet: 'npm install -g @anthropic-ai/claude-code',
      },
      {
        title: 'Configure environment or settings file',
        desc: 'Set the base URL and your Thruline API key, then run claude:',
        codeSnippet: 'claude',
      },
    ],
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    category: 'cli',
    image: '/providers/codex.png',
    badge: 'OpenAI CLI',
    tagline: 'OpenAI official terminal code generator and autonomous executor',
    docsUrl: 'https://github.com/openai/codex',
    protocol: 'OpenAI Responses (/thruline/v1/responses)',
    envVars: {
      baseUrlKey: 'OPENAI_BASE_URL',
      apiKeyKey: 'OPENAI_API_KEY',
      modelKey: 'CODEX_MODEL',
    },
    aliases: [
      { alias: 'default', targetModel: 'gpt-4o', desc: 'Flagship general coding model' },
      { alias: 'mini', targetModel: 'gpt-4o-mini', desc: 'Lightweight low-latency tasks' },
      { alias: 'reasoner', targetModel: 'o3-mini', desc: 'Deep reasoning and complex bugs' },
    ],
    configFile: {
      filename: 'config.toml',
      pathDesc: '~/.codex/config.toml',
      format: 'toml',
      generate: ({ baseUrl, apiKey }) =>
        `# OpenAI Codex CLI configuration for FreeLLMAPI Thruline\n[model]\ndefault = "gpt-4o"\nprovider = "custom"\n\n[providers.custom]\nbase_url = "${baseUrl}"\napi_key = "${apiKey}"\n`,
    },
    steps: [
      {
        title: 'Save Codex Configuration',
        desc: 'Create or update ~/.codex/config.toml with the generated config, or export the environment variables.',
      },
      {
        title: 'Launch Codex',
        desc: 'Run codex in your project directory:',
        codeSnippet: 'codex',
      },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor IDE',
    category: 'ide',
    image: '/providers/cursor.png',
    badge: 'AI IDE',
    tagline: 'AI-first code editor with inline editing and multi-file reasoning',
    docsUrl: 'https://docs.cursor.com',
    protocol: 'OpenAI Compatible (/thruline/v1)',
    envVars: {
      baseUrlKey: 'OPENAI_BASE_URL',
      apiKeyKey: 'OPENAI_API_KEY',
    },
    aliases: [
      { alias: 'claude-3-7-sonnet', targetModel: 'cc/claude-sonnet-4.5', desc: 'Cursor Sonnet mapping' },
      { alias: 'gpt-4o', targetModel: 'gpt-4o', desc: 'OpenAI GPT-4o mapping' },
      { alias: 'deepseek-chat', targetModel: 'deepseek/deepseek-chat', desc: 'DeepSeek V3' },
    ],
    steps: [
      {
        title: 'Open Cursor Settings',
        desc: 'Press Ctrl+Shift+J (or Cmd+Shift+J) -> Navigate to Models -> OpenAI API Key.',
      },
      {
        title: 'Override Base URL',
        desc: 'Click "Override OpenAI Base URL" and enter the Gateway URL:',
        codeSnippet: '{{baseUrl}}',
      },
      {
        title: 'Paste API Key',
        desc: 'Paste your Thruline API key (sk-xgw-...) into the OpenAI API Key field and click Verify.',
      },
    ],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    category: 'ide',
    image: '/providers/copilot.png',
    badge: 'VS Code Extension',
    tagline: 'GitHub Copilot with custom router backend for VS Code and JetBrains',
    docsUrl: 'https://marketplace.visualstudio.com/items?itemName=hotrungnhan.9router-for-github-copilot',
    protocol: 'OpenAI Compatible (/thruline/v1)',
    envVars: {
      baseUrlKey: 'OPENAI_BASE_URL',
      apiKeyKey: 'OPENAI_API_KEY',
    },
    steps: [
      {
        title: 'Install 9Router VS Code Extension',
        desc: 'In VS Code Extensions (Ctrl+Shift+X), search for "9Router for GitHub Copilot" or install via VSIX.',
      },
      {
        title: 'Configure Server Endpoint',
        desc: 'Press Ctrl+Shift+P, run "9Router: Configure Server", enter the Gateway URL and API key.',
      },
      {
        title: 'Select Model in Copilot Chat',
        desc: 'Open Copilot Chat -> click Model Picker -> pick your configured FreeLLMAPI models.',
      },
    ],
  },
  {
    id: 'cline',
    name: 'Cline & Roo Code',
    category: 'ide',
    image: '/providers/cline.png',
    badge: 'Agent Extension',
    tagline: 'Autonomous coding agents inside VS Code capable of multi-turn file edits',
    docsUrl: 'https://github.com/cline/cline',
    protocol: 'Anthropic or OpenAI Compatible (/thruline/v1)',
    envVars: {
      baseUrlKey: 'ANTHROPIC_BASE_URL',
      apiKeyKey: 'ANTHROPIC_API_KEY',
    },
    steps: [
      {
        title: 'Open Cline Settings',
        desc: 'Click the Settings gear icon in the top right of the Cline panel.',
      },
      {
        title: 'Select API Provider',
        desc: 'Choose "Anthropic Compatible" or "OpenAI Compatible".',
      },
      {
        title: 'Enter Base URL and Key',
        desc: 'Set Base URL to {{baseUrl}} and API Key to {{apiKey}}.',
      },
    ],
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    category: 'agent',
    image: '/providers/openclaw.png',
    badge: 'Multi-channel Agent',
    tagline: 'Autonomous AI assistant for Telegram, Discord, Slack, WhatsApp and CLI',
    docsUrl: 'https://openclaw.ai',
    protocol: 'OpenAI Compatible (/thruline/v1)',
    envVars: {
      baseUrlKey: 'OPENAI_BASE_URL',
      apiKeyKey: 'OPENAI_API_KEY',
      modelKey: 'OPENAI_MODEL',
    },
    configFile: {
      filename: '.env',
      pathDesc: 'openclaw/.env',
      format: 'yaml',
      generate: ({ baseUrl, apiKey }) =>
        `OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=${apiKey}\nOPENAI_MODEL=auto\n`,
    },
    steps: [
      {
        title: 'Set OpenClaw Environment',
        desc: 'Add the environment variables to your OpenClaw deployment .env file.',
      },
      {
        title: 'Start OpenClaw',
        desc: 'Run openclaw start to connect all messaging channels to Thruline.',
        codeSnippet: 'openclaw start',
      },
    ],
  },
  {
    id: 'continue',
    name: 'Continue.dev',
    category: 'ide',
    image: '/providers/continue.png',
    badge: 'IDE Assistant',
    tagline: 'Leading open-source AI code completion and chat extension for VS Code & JetBrains',
    docsUrl: 'https://docs.continue.dev',
    protocol: 'OpenAI Compatible (/thruline/v1)',
    envVars: {
      baseUrlKey: 'OPENAI_BASE_URL',
      apiKeyKey: 'OPENAI_API_KEY',
    },
    configFile: {
      filename: 'config.json',
      pathDesc: '~/.continue/config.json',
      format: 'json',
      generate: ({ baseUrl, apiKey }) =>
        JSON.stringify(
          {
            models: [
              {
                title: 'FreeLLMAPI Thruline',
                provider: 'openai',
                model: 'auto',
                apiBase: baseUrl,
                apiKey: apiKey,
              },
            ],
          },
          null,
          2
        ),
    },
    steps: [
      {
        title: 'Update Continue Configuration',
        desc: 'Paste the model definition into your ~/.continue/config.json or via the Continue UI settings.',
      },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    category: 'cli',
    image: '/providers/opencode.png',
    badge: 'Terminal Agent',
    tagline: 'Open-source CLI assistant with direct terminal and repo search tools',
    docsUrl: 'https://github.com/opencode-ai/opencode',
    protocol: 'OpenAI Compatible (/thruline/v1)',
    envVars: {
      baseUrlKey: 'OPENAI_BASE_URL',
      apiKeyKey: 'OPENAI_API_KEY',
    },
    steps: [
      {
        title: 'Export variables',
        desc: 'Export the OPENAI_BASE_URL and OPENAI_API_KEY variables in your shell.',
      },
      {
        title: 'Run OpenCode',
        desc: 'Launch opencode in your project folder:',
        codeSnippet: 'opencode',
      },
    ],
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    category: 'agent',
    image: '/providers/antigravity.png',
    badge: 'DeepMind Coding',
    tagline: 'Pair programming and autonomous developer workflows by Google DeepMind',
    docsUrl: 'https://deepmind.google',
    protocol: 'OpenAI / Claude Wire (/thruline/v1)',
    envVars: {
      baseUrlKey: 'OPENAI_BASE_URL',
      apiKeyKey: 'OPENAI_API_KEY',
    },
    steps: [
      {
        title: 'Connect Custom Model Provider',
        desc: 'In Antigravity settings or custom provider configuration, point the base URL to {{baseUrl}}.',
      },
    ],
  },
  {
    id: 'zed',
    name: 'Zed Editor',
    category: 'ide',
    image: '/providers/zed.png',
    badge: 'Fast Rust Editor',
    tagline: 'High-performance Rust-based code editor with built-in Assistant',
    docsUrl: 'https://zed.dev/docs/assistant',
    protocol: 'OpenAI Compatible (/thruline/v1)',
    envVars: {
      baseUrlKey: 'OPENAI_BASE_URL',
      apiKeyKey: 'OPENAI_API_KEY',
    },
    configFile: {
      filename: 'settings.json',
      pathDesc: '~/.config/zed/settings.json',
      format: 'json',
      generate: ({ baseUrl }) =>
        JSON.stringify(
          {
            language_models: {
              openai: {
                api_url: baseUrl,
                available_models: [
                  { name: 'auto', max_tokens: 32768 },
                  { name: 'gpt-4o', max_tokens: 16384 },
                  { name: 'cc/claude-sonnet-4.5', max_tokens: 32768 },
                ],
              },
            },
          },
          null,
          2
        ),
    },
    steps: [
      {
        title: 'Open Zed Settings',
        desc: 'Press Cmd+, or Ctrl+, then add the custom OpenAI endpoint config.',
      },
    ],
  },
];

export function formatBashExport(tool: CliTool, baseUrl: string, apiKey: string): string {
  const parts: string[] = [];
  parts.push(`export ${tool.envVars.baseUrlKey}="${baseUrl}"`);
  parts.push(`export ${tool.envVars.apiKeyKey}="${apiKey}"`);
  if (tool.envVars.modelKey) {
    parts.push(`export ${tool.envVars.modelKey}="auto"`);
  }
  if (tool.envVars.extra) {
    for (const [k, v] of Object.entries(tool.envVars.extra)) {
      parts.push(`export ${k}="${v}"`);
    }
  }
  return parts.join('\n');
}

export function formatPowerShellExport(tool: CliTool, baseUrl: string, apiKey: string): string {
  const parts: string[] = [];
  parts.push(`$env:${tool.envVars.baseUrlKey} = "${baseUrl}"`);
  parts.push(`$env:${tool.envVars.apiKeyKey} = "${apiKey}"`);
  if (tool.envVars.modelKey) {
    parts.push(`$env:${tool.envVars.modelKey} = "auto"`);
  }
  if (tool.envVars.extra) {
    for (const [k, v] of Object.entries(tool.envVars.extra)) {
      parts.push(`$env:${k} = "${v}"`);
    }
  }
  return parts.join('\n');
}

export function formatCmdExport(tool: CliTool, baseUrl: string, apiKey: string): string {
  const parts: string[] = [];
  parts.push(`set ${tool.envVars.baseUrlKey}=${baseUrl}`);
  parts.push(`set ${tool.envVars.apiKeyKey}=${apiKey}`);
  if (tool.envVars.modelKey) {
    parts.push(`set ${tool.envVars.modelKey}=auto`);
  }
  if (tool.envVars.extra) {
    for (const [k, v] of Object.entries(tool.envVars.extra)) {
      parts.push(`set ${k}=${v}`);
    }
  }
  return parts.join('\n');
}

export function formatEnvFile(tool: CliTool, baseUrl: string, apiKey: string): string {
  const parts: string[] = [];
  parts.push(`${tool.envVars.baseUrlKey}=${baseUrl}`);
  parts.push(`${tool.envVars.apiKeyKey}=${apiKey}`);
  if (tool.envVars.modelKey) {
    parts.push(`${tool.envVars.modelKey}=auto`);
  }
  if (tool.envVars.extra) {
    for (const [k, v] of Object.entries(tool.envVars.extra)) {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join('\n');
}
