import type { CliTool } from './operations-config';

export const EXTENDED_CLI_TOOLS: CliTool[] = [
  {
    id: 'hermes',
    name: 'Hermes Agent',
    category: 'agent',
    image: '/providers/hermes.png',
    badge: 'Autonomous Agent',
    tagline: 'Nous Research self-improving agent with multi-role routing & STT',
    docsUrl: 'https://github.com/NousResearch/hermes-agent',
    protocol: 'OpenAI Chat + Auxiliary Roles + STT (/thruline/v1)',
    envVars: {
      baseUrlKey: 'OPENAI_BASE_URL',
      apiKeyKey: 'OPENAI_API_KEY',
      modelKey: 'HERMES_MODEL',
    },
    aliases: [
      { alias: 'default', targetModel: 'auto', desc: 'Primary orchestrator model' },
      { alias: 'delegation', targetModel: 'cc/claude-sonnet-4.5', desc: 'Subagent delegation & task execution' },
      { alias: 'vision', targetModel: 'gemini/gemini-2.5-flash', desc: 'Multimodal inspection role' },
      { alias: 'compression', targetModel: 'groq/llama-3.3-70b-versatile', desc: 'Fast context compaction' },
    ],
    configFile: {
      filename: 'config.yaml',
      pathDesc: '~/.hermes/config.yaml',
      format: 'yaml',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        `# Hermes Agent configuration for FreeLLMAPI Thruline
model:
  default: ${model}
  provider: custom
  base_url: ${baseUrl}
  api_key: ${apiKey}

auxiliary:
  delegation:
    model: ${model}
    base_url: ${baseUrl}
    api_key: ${apiKey}
  vision:
    model: gemini/gemini-2.5-flash
    base_url: ${baseUrl}
    api_key: ${apiKey}
  compression:
    model: ${model}
    base_url: ${baseUrl}
    api_key: ${apiKey}
  skills_hub:
    model: ${model}
  mcp:
    model: ${model}
  review:
    model: ${model}
  goal_judge:
    model: ${model}

stt:
  enabled: true
  provider: openai
  base_url: ${baseUrl}
  api_key: ${apiKey}
  model: whisper-1
`,
    },
    steps: [
      {
        title: 'Save ~/.hermes/config.yaml',
        desc: 'Configure primary model, auxiliary multi-role slots (delegation, vision, compression, review), and Thruline STT.',
      },
    ],
  },
  {
    id: 'kiro',
    name: 'Kiro IDE',
    category: 'ide',
    image: '/providers/kiro.png',
    badge: 'AWS Agent IDE',
    tagline: 'Spec-driven AI IDE with Anthropic & OpenAI protocol routing',
    docsUrl: 'https://kiro.dev',
    protocol: 'Anthropic Messages (/thruline/v1/messages)',
    envVars: { baseUrlKey: 'ANTHROPIC_BASE_URL', apiKeyKey: 'ANTHROPIC_API_KEY', modelKey: 'KIRO_MODEL' },
    configFile: {
      filename: 'settings.json',
      pathDesc: '~/.kiro/settings.json',
      format: 'json',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        JSON.stringify({ endpoint: baseUrl, apiKey, defaultModel: model }, null, 2),
    },
  },
  {
    id: 'cowork',
    name: 'Claude Cowork',
    category: 'agent',
    image: '/providers/claude.png',
    badge: 'Desktop Agent',
    tagline: 'Claude Desktop collaborative coding environment via Thruline',
    docsUrl: 'https://docs.anthropic.com',
    protocol: 'Anthropic Messages (/thruline/v1/messages)',
    envVars: { baseUrlKey: 'ANTHROPIC_BASE_URL', apiKeyKey: 'ANTHROPIC_API_KEY', modelKey: 'ANTHROPIC_MODEL' },
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    category: 'cli',
    image: '/providers/droid.png',
    badge: 'Factory CLI',
    tagline: 'Factory Droid terminal coding assistant',
    docsUrl: 'https://docs.factory.ai',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'DROID_MODEL' },
    configFile: {
      filename: 'config.json',
      pathDesc: '~/.factory/config.json',
      format: 'json',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        JSON.stringify({ custom_models: [{ model_display_name: model, model, base_url: baseUrl, api_key: apiKey, provider: 'openai' }] }, null, 2),
    },
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    category: 'ide',
    image: '/providers/kilocode.png',
    badge: 'VS Code Ext',
    tagline: 'Autonomous VS Code coding agent with OpenAI-compatible routing',
    docsUrl: 'https://kilocode.ai',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'KILO_MODEL' },
  },
  {
    id: 'roo',
    name: 'Roo Code',
    category: 'ide',
    image: '/providers/roo.png',
    badge: 'VS Code Ext',
    tagline: 'Multi-mode IDE coding agent using Thruline OpenAI endpoint',
    docsUrl: 'https://roocode.com',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'ROO_MODEL' },
  },
  {
    id: 'amp',
    name: 'Amp CLI',
    category: 'cli',
    image: '/providers/amp.png',
    badge: 'Sourcegraph CLI',
    tagline: 'Sourcegraph Amp coding assistant routed via Thruline',
    docsUrl: 'https://ampcode.com',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'AMP_MODEL' },
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    category: 'cli',
    image: '/providers/qwen.png',
    badge: 'Qwen CLI',
    tagline: 'Qwen Code terminal agent supporting OpenAI & Anthropic models',
    docsUrl: 'https://qwenlm.github.io/qwen-code-docs/',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'OPENAI_MODEL' },
    configFile: {
      filename: 'settings.json',
      pathDesc: '~/.qwen/settings.json',
      format: 'json',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        JSON.stringify({ security: { auth: { selectedType: 'openai', apiKey, baseUrl } }, model: { name: model } }, null, 2),
    },
  },
  {
    id: 'deepseek-tui',
    name: 'DeepSeek TUI',
    category: 'cli',
    image: '/providers/deepseek-tui.png',
    badge: 'Rust TUI',
    tagline: 'DeepSeek Terminal Coding Agent configured via config.toml',
    docsUrl: 'https://github.com/DeepSeek-TUI/DeepSeek-TUI',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'DEEPSEEK_MODEL' },
    configFile: {
      filename: 'config.toml',
      pathDesc: '~/.deepseek/config.toml',
      format: 'toml',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        `provider = "openai"\nbase_url = "${baseUrl}"\napi_key = "${apiKey}"\nmodel = "${model}"\n`,
    },
  },
  {
    id: 'jcode',
    name: 'jcode',
    category: 'agent',
    image: '/providers/jcode.png',
    badge: 'Rust Agent',
    tagline: 'High-performance coding agent with multi-agent swarm support',
    docsUrl: 'https://github.com/1jehuang/jcode',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'JCODE_MODEL' },
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    category: 'cli',
    image: '/providers/grok-cli.png',
    badge: 'xAI TUI',
    tagline: 'xAI Grok Build terminal agent configured with Thruline upstream',
    docsUrl: 'https://x.ai/cli',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'GROK_MODEL' },
    configFile: {
      filename: 'config.toml',
      pathDesc: '~/.grok/config.toml',
      format: 'toml',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        `[model.thruline]\nbase_url = "${baseUrl}"\napi_key = "${apiKey}"\nmodel = "${model}"\ndefault = true\n`,
    },
  },
  {
    id: 'devin',
    name: 'Devin CLI',
    category: 'agent',
    image: '/providers/devin-cli.png',
    badge: 'ACP Agent',
    tagline: 'Cognition Devin CLI provider integration',
    docsUrl: 'https://cli.devin.ai',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'DEVIN_MODEL' },
  },
  {
    id: 'opendesign',
    name: 'OpenDesign',
    category: 'agent',
    image: '/providers/opendesign.png',
    badge: 'Design Skills',
    tagline: 'Agent-native design skills pack inheriting host model config',
    docsUrl: 'https://github.com/manalkaff/opendesign',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'OPENDESIGN_MODEL' },
  },
  {
    id: 'pi',
    name: 'Pi (pi-coding-agent)',
    category: 'cli',
    image: '/providers/pi.svg',
    badge: 'Minimal Harness',
    tagline: 'Minimal extensible coding agent harness (pi.dev)',
    docsUrl: 'https://pi.dev',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'PI_MODEL' },
    configFile: {
      filename: 'models.json',
      pathDesc: '~/.pi/agent/models.json',
      format: 'json',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        JSON.stringify({ providers: { thruline: { baseUrl, apiKey, api: 'openai-completions', models: [{ id: model }] } } }, null, 2),
    },
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    category: 'cli',
    image: '/providers/omp.png',
    badge: 'Auto-Discovery',
    tagline: 'Terminal coding agent with /v1/models auto-discovery',
    docsUrl: 'https://github.com/can1357/oh-my-pi',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'OMP_MODEL' },
    configFile: {
      filename: 'models.yml',
      pathDesc: '~/.omp/agent/models.yml',
      format: 'yaml',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        `providers:\n  thruline:\n    base_url: ${baseUrl}\n    api_key: ${apiKey}\n    default_model: ${model}\n`,
    },
  },
  {
    id: 'crush',
    name: 'Crush',
    category: 'cli',
    image: '/providers/crush.png',
    badge: 'Charm CLI',
    tagline: 'Charmbracelet Crush terminal AI coding agent',
    docsUrl: 'https://github.com/charmbracelet/crush',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'CRUSH_MODEL' },
    configFile: {
      filename: 'crush.json',
      pathDesc: '~/.config/crush/crush.json',
      format: 'json',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        JSON.stringify({ providers: { thruline: { type: 'openai-compat', base_url: baseUrl, api_key: apiKey, models: [{ id: model }] } } }, null, 2),
    },
  },
  {
    id: 'forge',
    name: 'ForgeCode',
    category: 'cli',
    image: '/providers/forge.png',
    badge: 'Forge CLI',
    tagline: 'Antinomy HQ ForgeCode agent harness',
    docsUrl: 'https://github.com/antinomyhq/forge',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'FORGE_MODEL' },
    configFile: {
      filename: 'config.toml',
      pathDesc: '~/.forge/config.toml',
      format: 'toml',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        `[openai]\nbaseUrl = "${baseUrl}"\napiKey = "${apiKey}"\nmodel = "${model}"\n`,
    },
  },
  {
    id: 'smelt',
    name: 'Smelt',
    category: 'cli',
    image: '/providers/smelt.svg',
    badge: 'Smelt CLI',
    tagline: 'Smelt terminal AI coding assistant',
    docsUrl: 'https://github.com/leonardcser/smelt',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'SMELT_MODEL' },
    configFile: {
      filename: 'config.json',
      pathDesc: '~/.smelt/config.json',
      format: 'json',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        JSON.stringify({ openai: { baseUrl, apiKey, model } }, null, 2),
    },
  },
  {
    id: 'codewhale',
    name: 'CodeWhale',
    category: 'cli',
    image: '/providers/codewhale.svg',
    badge: 'Rust TUI',
    tagline: 'CodeWhale terminal coding agent (successor to DeepSeek TUI)',
    docsUrl: 'https://github.com/Hmbown/CodeWhale',
    protocol: 'OpenAI Chat Completions (/thruline/v1/chat/completions)',
    envVars: { baseUrlKey: 'OPENAI_BASE_URL', apiKeyKey: 'OPENAI_API_KEY', modelKey: 'CODEWHALE_MODEL' },
    configFile: {
      filename: 'config.toml',
      pathDesc: '~/.codewhale/config.toml',
      format: 'toml',
      generate: ({ baseUrl, apiKey, model = 'auto' }) =>
        `[openai]\nbase_url = "${baseUrl}"\napi_key = "${apiKey}"\nmodel = "${model}"\n`,
    },
  },
];
