import { CodexProvider } from './codex.js';
import { GeminiCliProvider } from './gemini-cli.js';
import { KiroProvider } from './kiro.js';
import type { Platform } from '@freellmapi/shared/types.js';
import type { ProviderAccountAuthMethod, ProviderCategory } from '@freellmapi/shared/x-accounts.js';
import type { BaseProvider } from '../../providers/base.js';
import { resolveProvider } from '../../providers/index.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { CopilotProvider } from './copilot.js';
import { COPILOT_BASE_URL } from './http.js';
import { AnthropicWireProvider, WebCookieProvider } from './web-cookie.js';
import { QoderProvider } from './qoder.js';

export interface XGatewayCatalogProvider {
  id: string;
  alias: string;
  name: string;
  category: ProviderCategory;
  authMethods: ProviderAccountAuthMethod[];
  baseUrl: string;
  models: { id: string; name: string }[];
}

export const X_GATEWAY_PROVIDERS: readonly XGatewayCatalogProvider[] = [
  {
    "id": "agnes",
    "alias": "agnes",
    "name": "Agnes AI",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://apihub.agnes-ai.com/v1",
    "models": [
      {
        "id": "agnes-2.5-flash",
        "name": "Agnes 2.5 Flash"
      },
      {
        "id": "agnes-2.5-pro",
        "name": "Agnes 2.5 Pro"
      },
      {
        "id": "agnes-2.5-pro-beta",
        "name": "Agnes 2.5 Pro Beta"
      },
      {
        "id": "agnes-3.0-flash",
        "name": "Agnes 3.0 Flash"
      }
    ]
  },
  {
    "id": "alicode",
    "alias": "alicode",
    "name": "Alibaba",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
    "models": [
      {
        "id": "qwen3.5-plus",
        "name": "Qwen3.5 Plus"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "qwen3-max-2026-01-23",
        "name": "Qwen3 Max"
      },
      {
        "id": "qwen3-coder-next",
        "name": "Qwen3 Coder Next"
      },
      {
        "id": "qwen3-coder-plus",
        "name": "Qwen3 Coder Plus"
      },
      {
        "id": "glm-4.7",
        "name": "GLM 4.7"
      }
    ]
  },
  {
    "id": "alicode-intl",
    "alias": "alicode-intl",
    "name": "Alibaba Coding",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1",
    "models": [
      {
        "id": "qwen3.5-plus",
        "name": "Qwen3.5 Plus"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "qwen3-coder-next",
        "name": "Qwen3 Coder Next"
      },
      {
        "id": "qwen3-coder-plus",
        "name": "Qwen3 Coder Plus"
      },
      {
        "id": "glm-4.7",
        "name": "GLM 4.7"
      }
    ]
  },
  {
    "id": "alims-intl",
    "alias": "alims-intl",
    "name": "Alibaba Studio",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "models": [
      {
        "id": "qwen3.5-plus",
        "name": "Qwen3.5 Plus"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "qwen3-coder-next",
        "name": "Qwen3 Coder Next"
      },
      {
        "id": "qwen3-coder-plus",
        "name": "Qwen3 Coder Plus"
      },
      {
        "id": "glm-4.7",
        "name": "GLM 4.7"
      }
    ]
  },
  {
    "id": "alitp-intl",
    "alias": "alitp-intl",
    "name": "Alibaba Token Plan",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "models": [
      {
        "id": "qwen3.8-max-preview",
        "name": "Qwen3.8 Max Preview"
      },
      {
        "id": "qwen3.7-max",
        "name": "Qwen3.7 Max"
      },
      {
        "id": "qwen3.7-plus",
        "name": "Qwen3.7 Plus"
      },
      {
        "id": "qwen3.6-flash",
        "name": "Qwen3.6 Flash"
      },
      {
        "id": "glm-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      }
    ]
  },
  {
    "id": "anthropic",
    "alias": "anthropic",
    "name": "Anthropic",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.anthropic.com/v1",
    "models": [
      {
        "id": "claude-sonnet-4-20250514",
        "name": "Claude Sonnet 4"
      },
      {
        "id": "claude-opus-4-20250514",
        "name": "Claude Opus 4"
      },
      {
        "id": "claude-3-5-sonnet-20241022",
        "name": "Claude 3.5 Sonnet"
      }
    ]
  },
  {
    "id": "antigravity",
    "alias": "ag",
    "name": "Antigravity",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com/v1internal",
    "models": [
      {
        "id": "gemini-4-argon-high",
        "name": "Gemini 4 Argon (High)"
      },
      {
        "id": "gemini-4-argon-medium",
        "name": "Gemini 4 Argon (Medium)"
      },
      {
        "id": "gemini-4-argon-low",
        "name": "Gemini 4 Argon (Low)"
      },
      {
        "id": "gemini-3.8-flash-high",
        "name": "Gemini 3.8 Flash (High)"
      },
      {
        "id": "gemini-3.8-flash-medium",
        "name": "Gemini 3.8 Flash (Medium)"
      },
      {
        "id": "gemini-3.8-flash-low",
        "name": "Gemini 3.8 Flash (Low)"
      },
      {
        "id": "gemini-3.8-flash",
        "name": "Gemini 3.8 Flash"
      },
      {
        "id": "gemini-3.7-flash-high",
        "name": "Gemini 3.7 Flash (High)"
      },
      {
        "id": "gemini-3.7-flash-medium",
        "name": "Gemini 3.7 Flash (Medium)"
      },
      {
        "id": "gemini-3.7-flash-low",
        "name": "Gemini 3.7 Flash (Low)"
      },
      {
        "id": "gemini-3.6-flash-high",
        "name": "Gemini 3.6 Flash (High)"
      },
      {
        "id": "gemini-3.6-flash-medium",
        "name": "Gemini 3.6 Flash (Medium)"
      },
      {
        "id": "gemini-3.6-flash-low",
        "name": "Gemini 3.6 Flash (Low)"
      },
      {
        "id": "gemini-3.1-pro-high",
        "name": "Gemini 3.1 Pro (High)"
      },
      {
        "id": "gemini-pro-agent",
        "name": "Gemini 3.1 Pro (High)"
      },
      {
        "id": "gemini-3.1-pro-low",
        "name": "Gemini 3.1 Pro (Low)"
      },
      {
        "id": "claude-sonnet-5-5-high",
        "name": "Claude Sonnet 5.5 (High)"
      },
      {
        "id": "claude-sonnet-5-5-medium",
        "name": "Claude Sonnet 5.5 (Medium)"
      },
      {
        "id": "claude-sonnet-5-5-low",
        "name": "Claude Sonnet 5.5 (Low)"
      },
      {
        "id": "claude-sonnet-5-5",
        "name": "Claude Sonnet 5.5 (Thinking)"
      },
      {
        "id": "claude-opus-5-5-high",
        "name": "Claude Opus 5.5 (High)"
      },
      {
        "id": "claude-opus-5-5-medium",
        "name": "Claude Opus 5.5 (Medium)"
      },
      {
        "id": "claude-opus-5-5-low",
        "name": "Claude Opus 5.5 (Low)"
      },
      {
        "id": "claude-opus-5-5",
        "name": "Claude Opus 5.5 (Thinking)"
      },
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6 (Thinking)"
      },
      {
        "id": "claude-opus-4-6-thinking",
        "name": "Claude Opus 4.6 (Thinking)"
      },
      {
        "id": "gpt-oss-120b-medium",
        "name": "GPT-OSS 120B (Medium)"
      },
      {
        "id": "gemini-3.1-flash-image",
        "name": "Gemini 3.1 Flash (Image)"
      }
    ]
  },
  {
    "id": "api-airforce",
    "alias": "af",
    "name": "API.airforce",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.airforce/v1",
    "models": [
      {
        "id": "gpt-oss-120b",
        "name": "GPT-OSS 120B (Free)"
      },
      {
        "id": "gpt-oss-20b",
        "name": "GPT-OSS 20B (Free)"
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code (Free)"
      }
    ]
  },
  {
    "id": "assemblyai",
    "alias": "aai",
    "name": "AssemblyAI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.assemblyai.com/v1/audio/transcriptions",
    "models": [
      {
        "id": "universal-3-pro",
        "name": "Universal 3 Pro"
      },
      {
        "id": "universal-2",
        "name": "Universal 2"
      },
      {
        "id": "best",
        "name": "Best (Nano + Universal)"
      },
      {
        "id": "nano",
        "name": "Nano (Fast)"
      }
    ]
  },
  {
    "id": "atria",
    "alias": "atria",
    "name": "Atria Dawn",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.atria-asi.ai/v1",
    "models": [
      {
        "id": "Atria-Dawn-Preview",
        "name": "Atria Dawn Preview"
      }
    ]
  },
  {
    "id": "bedrock",
    "alias": "br",
    "name": "AWS Bedrock",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://bedrock-runtime.{region}.amazonaws.com",
    "models": [
      {
        "id": "us.anthropic.claude-opus-5",
        "name": "Claude Opus 5"
      },
      {
        "id": "us.anthropic.claude-sonnet-5",
        "name": "Claude Sonnet 5"
      },
      {
        "id": "us.anthropic.claude-fable-5",
        "name": "Claude Fable 5"
      },
      {
        "id": "us.anthropic.claude-opus-4-8",
        "name": "Claude Opus 4.8"
      },
      {
        "id": "us.anthropic.claude-opus-4-7",
        "name": "Claude Opus 4.7"
      },
      {
        "id": "us.anthropic.claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "us.anthropic.claude-opus-4-5-20251101-v1:0",
        "name": "Claude Opus 4.5"
      },
      {
        "id": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "name": "Claude Sonnet 4.5"
      },
      {
        "id": "us.anthropic.claude-opus-4-1-20250805-v1:0",
        "name": "Claude Opus 4.1"
      },
      {
        "id": "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "name": "Claude Sonnet 4"
      },
      {
        "id": "us.anthropic.claude-3-haiku-20240307-v1:0",
        "name": "Claude 3 Haiku"
      }
    ]
  },
  {
    "id": "bedrock-xai",
    "alias": "brx",
    "name": "AWS Bedrock (xAI)",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://bedrock-runtime.{region}.amazonaws.com",
    "models": [
      {
        "id": "us.xai.grok-4.6",
        "name": "Grok 4.6"
      },
      {
        "id": "global.xai.grok-4.6",
        "name": "Grok 4.6 (global)"
      }
    ]
  },
  {
    "id": "aws-polly",
    "alias": "polly",
    "name": "AWS Polly",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "AWS Polly Default"
      }
    ]
  },
  {
    "id": "azure",
    "alias": "azure",
    "name": "Azure OpenAI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://models.inference.ai.azure.com",
    "models": [
      {
        "id": "gpt-4o",
        "name": "GPT-4o"
      },
      {
        "id": "gpt-4o-mini",
        "name": "GPT-4o Mini"
      }
    ]
  },
  {
    "id": "bai",
    "alias": "bai",
    "name": "B.AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.b.ai/v1",
    "models": [
      {
        "id": "gpt-4o-mini",
        "name": "GPT-4o Mini"
      },
      {
        "id": "claude-3-5-sonnet",
        "name": "Claude 3.5 Sonnet"
      }
    ]
  },
  {
    "id": "baidu",
    "alias": "qianfan",
    "name": "Baidu Qianfan",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://qianfan.baidubce.com/v2",
    "models": [
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "glm-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "glm-5.1",
        "name": "GLM 5.1"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "qwen3.5-397b-a17b",
        "name": "Qwen 3.5 397B A17B"
      },
      {
        "id": "qwen3.5-27b",
        "name": "Qwen 3.5 27B"
      }
    ]
  },
  {
    "id": "bazaarlink",
    "alias": "bzl",
    "name": "Bazaarlink",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://bazaarlink.ai/api/v1",
    "models": [
      {
        "id": "auto:free",
        "name": "Auto Free (Zero Cost)"
      },
      {
        "id": "claude-opus-4.7",
        "name": "Claude Opus 4.7"
      },
      {
        "id": "claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "claude-haiku-4.5",
        "name": "Claude Haiku 4.5"
      },
      {
        "id": "gpt-5.5",
        "name": "GPT-5.5"
      },
      {
        "id": "gpt-5.4",
        "name": "GPT-5.4"
      },
      {
        "id": "gpt-5.4-mini",
        "name": "GPT-5.4 Mini"
      },
      {
        "id": "gpt-5.4-nano",
        "name": "GPT-5.4 Nano"
      },
      {
        "id": "grok-4.3",
        "name": "Grok 4.3"
      },
      {
        "id": "grok-4.20",
        "name": "Grok 4.20"
      },
      {
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro"
      },
      {
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash"
      },
      {
        "id": "gemini-3.1-flash-lite-preview",
        "name": "Gemini 3.1 Flash Lite"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "glm-5.1",
        "name": "GLM 5.1"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "mimo-v2.5-pro",
        "name": "MiMo-V2.5-Pro"
      },
      {
        "id": "mimo-v2.5",
        "name": "MiMo-V2.5"
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax M3"
      },
      {
        "id": "minimax-m2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "minimax-m2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen 3.6 Plus"
      },
      {
        "id": "nemotron-3-super-120b-a12b",
        "name": "Nemotron 3 Super"
      }
    ]
  },
  {
    "id": "black-forest-labs",
    "alias": "bfl",
    "name": "Black Forest Labs",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "flux-pro-1.1",
        "name": "FLUX Pro 1.1"
      },
      {
        "id": "flux-pro-1.1-ultra",
        "name": "FLUX Pro 1.1 Ultra"
      },
      {
        "id": "flux-pro",
        "name": "FLUX Pro"
      },
      {
        "id": "flux-dev",
        "name": "FLUX Dev"
      },
      {
        "id": "flux-kontext-pro",
        "name": "FLUX Kontext Pro (Edit)"
      },
      {
        "id": "flux-kontext-max",
        "name": "FLUX Kontext Max (Edit)"
      }
    ]
  },
  {
    "id": "blackbox",
    "alias": "bb",
    "name": "Blackbox AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.blackbox.ai/v1",
    "models": [
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5"
      },
      {
        "id": "claude-opus-4.8",
        "name": "Claude Opus 4.8"
      },
      {
        "id": "claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "gpt-5.5",
        "name": "GPT-5.5"
      },
      {
        "id": "gpt-5.4-pro",
        "name": "GPT-5.4 Pro"
      },
      {
        "id": "gpt-5.4",
        "name": "GPT-5.4"
      },
      {
        "id": "gpt-5.3-codex",
        "name": "GPT-5.3 Codex"
      },
      {
        "id": "gpt-5.4-nano",
        "name": "GPT-5.4 Nano"
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "grok-4.3",
        "name": "Grok 4.3"
      }
    ]
  },
  {
    "id": "bluesminds",
    "alias": "bm",
    "name": "BluesMinds",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.bluesminds.com/v1",
    "models": [
      {
        "id": "gpt-4.1",
        "name": "GPT-4.1"
      },
      {
        "id": "gpt-4.1-mini",
        "name": "GPT-4.1 Mini"
      },
      {
        "id": "gpt-4.1-nano",
        "name": "GPT-4.1 Nano"
      },
      {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5"
      },
      {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5"
      },
      {
        "id": "gemini-2.0-flash",
        "name": "Gemini 2.0 Flash"
      },
      {
        "id": "gemini-2.0-flash-exp",
        "name": "Gemini 2.0 Flash (Exp)"
      },
      {
        "id": "qwen-turbo",
        "name": "Qwen Turbo"
      },
      {
        "id": "kimi-k2",
        "name": "Kimi K2"
      },
      {
        "id": "kimi-k2-thinking",
        "name": "Kimi K2 Thinking"
      },
      {
        "id": "glm-4.7",
        "name": "GLM 4.7"
      },
      {
        "id": "minimax-m2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "claude-opus-4-5",
        "name": "Claude Opus 4.5 (VIP)"
      },
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro (VIP)"
      }
    ]
  },
  {
    "id": "brave-search",
    "alias": "brave",
    "name": "Brave Search",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Brave Search Default"
      }
    ]
  },
  {
    "id": "byteplus",
    "alias": "bpm",
    "name": "BytePlus ModelArk",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
    "models": [
      {
        "id": "seed-2-0-pro-260328",
        "name": "Seed 2.0 Pro"
      },
      {
        "id": "seed-2-0-code-preview-260328",
        "name": "Seed 2.0 Code Preview"
      },
      {
        "id": "seed-2-0-mini-260215",
        "name": "Seed 2.0 Mini"
      },
      {
        "id": "seed-2-0-lite-260228",
        "name": "Seed 2.0 Lite"
      },
      {
        "id": "kimi-k2-thinking-251104",
        "name": "Kimi K2 Thinking"
      },
      {
        "id": "glm-4-7-251222",
        "name": "GLM 4.7"
      },
      {
        "id": "gpt-oss-120b-250805",
        "name": "GPT-OSS-120B"
      }
    ]
  },
  {
    "id": "cartesia",
    "alias": "cartesia",
    "name": "Cartesia",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Cartesia Default"
      }
    ]
  },
  {
    "id": "cerebras",
    "alias": "cerebras",
    "name": "Cerebras",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.cerebras.ai/v1",
    "models": [
      {
        "id": "gpt-oss-120b",
        "name": "GPT OSS 120B"
      },
      {
        "id": "zai-glm-4.7",
        "name": "ZAI GLM 4.7"
      },
      {
        "id": "llama-3.3-70b",
        "name": "Llama 3.3 70B"
      },
      {
        "id": "llama-4-scout-17b-16e-instruct",
        "name": "Llama 4 Scout"
      },
      {
        "id": "qwen-3-235b-a22b-instruct-2507",
        "name": "Qwen3 235B A22B"
      },
      {
        "id": "qwen-3-32b",
        "name": "Qwen3 32B"
      }
    ]
  },
  {
    "id": "chatgpt-web",
    "alias": "chatgpt-web",
    "name": "ChatGPT Web",
    "category": "webCookie",
    "authMethods": [
      "cookie",
      "api_key"
    ],
    "baseUrl": "https://chatgpt.com",
    "models": [
      {
        "id": "gpt-5-6",
        "name": "GPT-5.6 Sol — Instant"
      },
      {
        "id": "gpt-5-6-thinking",
        "name": "GPT-5.6 Sol — Thinking"
      },
      {
        "id": "gpt-5-6-pro",
        "name": "GPT-5.6 Sol — Pro"
      },
      {
        "id": "gpt-5.6-luna-free",
        "name": "GPT-5.6 Luna — Free"
      },
      {
        "id": "gpt-5.6-luna-free-thinking",
        "name": "GPT-5.6 Luna — Free Thinking"
      },
      {
        "id": "gpt-5-5-instant",
        "name": "GPT-5.5 — Instant"
      },
      {
        "id": "gpt-5-5-thinking",
        "name": "GPT-5.5 — Thinking"
      },
      {
        "id": "gpt-5-5-pro",
        "name": "GPT-5.5 — Pro"
      },
      {
        "id": "gpt-image-2",
        "name": "GPT Image 2 (web)"
      }
    ]
  },
  {
    "id": "chutes",
    "alias": "ch",
    "name": "Chutes AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://llm.chutes.ai/v1",
    "models": [
      {
        "id": "default",
        "name": "Chutes AI Default"
      }
    ]
  },
  {
    "id": "claude",
    "alias": "cc",
    "name": "Claude Code",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.anthropic.com/v1",
    "models": [
      {
        "id": "claude-opus-5-5",
        "name": "Claude Opus 5.5"
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5"
      },
      {
        "id": "claude-fable-5-1",
        "name": "Claude Fable 5.1"
      },
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5"
      },
      {
        "id": "claude-sonnet-5-5",
        "name": "Claude Sonnet 5.5"
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5"
      },
      {
        "id": "claude-haiku-4-5-20251001",
        "name": "Claude 4.5 Haiku"
      }
    ]
  },
  {
    "id": "cline",
    "alias": "cl",
    "name": "Cline",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.cline.bot/api/v1",
    "models": [
      {
        "id": "anthropic/claude-opus-4.7",
        "name": "Claude Opus 4.7"
      },
      {
        "id": "anthropic/claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "anthropic/claude-opus-4.6",
        "name": "Claude Opus 4.6"
      },
      {
        "id": "openai/gpt-5.3-codex",
        "name": "GPT-5.3 Codex"
      },
      {
        "id": "openai/gpt-5.4",
        "name": "GPT-5.4"
      },
      {
        "id": "google/gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview"
      },
      {
        "id": "google/gemini-3.1-flash-lite-preview",
        "name": "Gemini 3.1 Flash Lite Preview"
      },
      {
        "id": "kwaipilot/kat-coder-pro",
        "name": "KAT Coder Pro"
      }
    ]
  },
  {
    "id": "clinepass",
    "alias": "clinepass",
    "name": "ClinePass",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.cline.bot/api/v1",
    "models": [
      {
        "id": "cline-pass/glm-5.2",
        "name": "GLM-5.2 (ClinePass)"
      },
      {
        "id": "cline-pass/kimi-k2.7-code",
        "name": "Kimi K2.7 Code (ClinePass)"
      },
      {
        "id": "cline-pass/kimi-k2.6",
        "name": "Kimi K2.6 (ClinePass)"
      },
      {
        "id": "cline-pass/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro (ClinePass)"
      },
      {
        "id": "cline-pass/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash (ClinePass)"
      },
      {
        "id": "cline-pass/mimo-v2.5",
        "name": "MiMo-V2.5 (ClinePass)"
      },
      {
        "id": "cline-pass/mimo-v2.5-pro",
        "name": "MiMo-V2.5-Pro (ClinePass)"
      },
      {
        "id": "cline-pass/minimax-m3",
        "name": "MiniMax M3 (ClinePass)"
      },
      {
        "id": "cline-pass/qwen3.7-max",
        "name": "Qwen3.7 Max (ClinePass)"
      },
      {
        "id": "cline-pass/qwen3.7-plus",
        "name": "Qwen3.7 Plus (ClinePass)"
      }
    ]
  },
  {
    "id": "cloudflare-ai",
    "alias": "cf",
    "name": "Cloudflare",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.cloudflare.com/client/v4/accounts",
    "models": [
      {
        "id": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "name": "Llama 3.3 70B Instruct"
      },
      {
        "id": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        "name": "DeepSeek R1 Distill Qwen 32B"
      },
      {
        "id": "@cf/cloudflare/clef-flash",
        "name": "Clef Flash"
      },
      {
        "id": "@cf/meta/llama-3.2-1b-instruct",
        "name": "Llama 3.2 1B Instruct"
      },
      {
        "id": "@cf/meta/llama-3.2-3b-instruct",
        "name": "Llama 3.2 3B Instruct"
      },
      {
        "id": "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
        "name": "Llama 3.1 8B Instruct FP8 Fast"
      },
      {
        "id": "@cf/meta/llama-3.1-8b-instruct-awq",
        "name": "Llama 3.1 8B Instruct AWQ"
      },
      {
        "id": "@cf/mistralai/mistral-small-3.1-24b-instruct",
        "name": "Mistral Small 3.1 24B Instruct"
      },
      {
        "id": "@cf/meta/llama-3.1-70b-instruct-fp8-fast",
        "name": "Llama 3.1 70B Instruct FP8 Fast"
      },
      {
        "id": "@cf/moonshotai/kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "@cf/moonshotai/kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "@cf/zai-org/glm-4.7-flash",
        "name": "GLM 4.7 Flash"
      },
      {
        "id": "@cf/qwen/qwq-32b",
        "name": "QwQ 32B"
      },
      {
        "id": "@cf/qwen/qwen2.5-coder-32b-instruct",
        "name": "Qwen 2.5 Coder 32B Instruct"
      },
      {
        "id": "@cf/black-forest-labs/flux-2-klein-9b",
        "name": "FLUX.2 Klein 9B"
      },
      {
        "id": "@cf/black-forest-labs/flux-2-klein-4b",
        "name": "FLUX.2 Klein 4B"
      },
      {
        "id": "@cf/black-forest-labs/flux-2-dev",
        "name": "FLUX.2 Dev"
      },
      {
        "id": "@cf/leonardo/lucid-origin",
        "name": "Lucid Origin"
      },
      {
        "id": "@cf/leonardo/phoenix-1.0",
        "name": "Phoenix 1.0"
      },
      {
        "id": "@cf/black-forest-labs/flux-1-schnell",
        "name": "FLUX.1 Schnell"
      },
      {
        "id": "@cf/bytedance/stable-diffusion-xl-lightning",
        "name": "SDXL Lightning"
      },
      {
        "id": "@cf/lykon/dreamshaper-8-lcm",
        "name": "DreamShaper 8 LCM"
      },
      {
        "id": "@cf/runwayml/stable-diffusion-v1-5-img2img",
        "name": "Stable Diffusion v1.5 Img2Img"
      },
      {
        "id": "@cf/runwayml/stable-diffusion-v1-5-inpainting",
        "name": "Stable Diffusion v1.5 Inpainting"
      },
      {
        "id": "@cf/stabilityai/stable-diffusion-xl-base-1.0",
        "name": "SDXL Base 1.0"
      }
    ]
  },
  {
    "id": "codebuddy-intl",
    "alias": "cbai",
    "name": "CodeBuddy",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://www.codebuddy.ai/v2",
    "models": [
      {
        "id": "glm-5.2",
        "name": "GLM-5.2"
      },
      {
        "id": "glm-5.1",
        "name": "GLM-5.1"
      },
      {
        "id": "glm-5.0",
        "name": "GLM-5.0"
      },
      {
        "id": "glm-5.0-turbo",
        "name": "GLM-5.0-Turbo"
      },
      {
        "id": "glm-5v-turbo",
        "name": "GLM-5v-Turbo"
      },
      {
        "id": "glm-4.7",
        "name": "GLM-4.7"
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax-M3"
      },
      {
        "id": "minimax-m2.7",
        "name": "MiniMax-M2.7"
      },
      {
        "id": "kimi-k2.7",
        "name": "Kimi-K2.7-Code"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi-K2.6"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi-K2.5"
      },
      {
        "id": "hy3-preview",
        "name": "Hy3 Preview"
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek-V4-Pro"
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek-V4.1-Flash"
      },
      {
        "id": "deepseek-v3-2-volc",
        "name": "DeepSeek-V3.2"
      }
    ]
  },
  {
    "id": "codebuddy-cn",
    "alias": "cbcn",
    "name": "CodeBuddy CN",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://copilot.tencent.com/v2",
    "models": [
      {
        "id": "glm-5.2",
        "name": "GLM-5.2"
      },
      {
        "id": "glm-5.1",
        "name": "GLM-5.1"
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax-M3"
      },
      {
        "id": "hy3",
        "name": "Hy3"
      },
      {
        "id": "hy4-preview",
        "name": "Hy4-Preview"
      },
      {
        "id": "glm-5.3",
        "name": "GLM-5.3"
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash"
      },
      {
        "id": "kimi-k3-1",
        "name": "Kimi-K3"
      },
      {
        "id": "kimi-k2.8-preview",
        "name": "Kimi-K2.8-Preview"
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek-V4-Pro"
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek-V4.1-Flash"
      }
    ]
  },
  {
    "id": "cohere",
    "alias": "cohere",
    "name": "Cohere",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.cohere.ai/v1",
    "models": [
      {
        "id": "command-r-plus-08-2024",
        "name": "Command R+ (Aug 2024)"
      },
      {
        "id": "command-r-08-2024",
        "name": "Command R (Aug 2024)"
      },
      {
        "id": "command-a-03-2025",
        "name": "Command A (Mar 2025)"
      }
    ]
  },
  {
    "id": "comfyui",
    "alias": "comfyui",
    "name": "ComfyUI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "flux-dev",
        "name": "FLUX Dev"
      },
      {
        "id": "sdxl",
        "name": "SDXL"
      }
    ]
  },
  {
    "id": "commandcode",
    "alias": "cmc",
    "name": "Command Code",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.commandcode.ai/alpha/generate",
    "models": [
      {
        "id": "deepseek/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "moonshotai/Kimi-K3.1-Pro",
        "name": "Kimi K3.1 Pro"
      },
      {
        "id": "moonshotai/Kimi-K2.7-Code",
        "name": "Kimi K2.7 Code"
      },
      {
        "id": "moonshotai/Kimi-K2.7-Code-Highspeed",
        "name": "Kimi K2.7 Code HighSpeed"
      },
      {
        "id": "moonshotai/Kimi-K2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "moonshotai/Kimi-K2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "zai-org/GLM-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "zai-org/GLM-5.2-Fast",
        "name": "GLM 5.2 Fast"
      },
      {
        "id": "zai-org/GLM-5.1",
        "name": "GLM 5.1"
      },
      {
        "id": "zai-org/GLM-5",
        "name": "GLM 5"
      },
      {
        "id": "MiniMaxAI/MiniMax-M3",
        "name": "MiniMax M3"
      },
      {
        "id": "MiniMaxAI/MiniMax-M2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "MiniMaxAI/MiniMax-M2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "xiaomi/mimo-v2.5-pro",
        "name": "MiMo V2.5 Pro"
      },
      {
        "id": "xiaomi/mimo-v2.5",
        "name": "MiMo V2.5"
      },
      {
        "id": "Qwen/Qwen3.6-Max-Preview",
        "name": "Qwen 3.6 Max Preview"
      },
      {
        "id": "Qwen/Qwen3.6-Plus",
        "name": "Qwen 3.6 Plus"
      },
      {
        "id": "Qwen/Qwen3.7-Max",
        "name": "Qwen 3.7 Max"
      },
      {
        "id": "Qwen/Qwen3.7-Plus",
        "name": "Qwen 3.7 Plus"
      },
      {
        "id": "stepfun/Step-3.7-Flash",
        "name": "Step 3.7 Flash"
      },
      {
        "id": "stepfun/Step-3.5-Flash",
        "name": "Step 3.5 Flash"
      },
      {
        "id": "nvidia/nemotron-3-ultra-550b-a55b",
        "name": "Nemotron 3 Ultra"
      }
    ]
  },
  {
    "id": "coqui",
    "alias": "coqui",
    "name": "Coqui TTS",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Coqui TTS Default"
      }
    ]
  },
  {
    "id": "cursor",
    "alias": "cu",
    "name": "Cursor IDE",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api2.cursor.sh",
    "models": [
      {
        "id": "default",
        "name": "Auto (Server Picks)"
      },
      {
        "id": "claude-4.5-opus-high-thinking",
        "name": "Claude 4.5 Opus High Thinking"
      },
      {
        "id": "claude-4.5-opus-high",
        "name": "Claude 4.5 Opus High"
      },
      {
        "id": "claude-4.5-sonnet-thinking",
        "name": "Claude 4.5 Sonnet Thinking"
      },
      {
        "id": "claude-4.5-sonnet",
        "name": "Claude 4.5 Sonnet"
      },
      {
        "id": "claude-4.5-haiku",
        "name": "Claude 4.5 Haiku"
      },
      {
        "id": "claude-4.5-opus",
        "name": "Claude 4.5 Opus"
      },
      {
        "id": "gpt-5.2-codex",
        "name": "GPT 5.2 Codex"
      },
      {
        "id": "claude-4.6-opus-max",
        "name": "Claude 4.6 Opus Max"
      },
      {
        "id": "claude-4.6-sonnet-medium-thinking",
        "name": "Claude 4.6 Sonnet Medium Thinking"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview"
      },
      {
        "id": "gpt-5.2",
        "name": "GPT 5.2"
      },
      {
        "id": "gpt-5.3-codex",
        "name": "GPT 5.3 Codex"
      }
    ]
  },
  {
    "id": "custom",
    "alias": "custom",
    "name": "Custom (OpenAI-compatible)",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "",
    "models": []
  },
  {
    "id": "dahl",
    "alias": "dahl",
    "name": "Dahl Inference",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://inference.dahl.global/v1",
    "models": [
      {
        "id": "zai-org/GLM-5.3-Flash",
        "name": "GLM-5.3 Flash"
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
        "name": "DeepSeek V4 Flash 0731"
      },
      {
        "id": "MiniMaxAI/MiniMax-M2.7",
        "name": "MiniMax M2.7"
      }
    ]
  },
  {
    "id": "deepgram",
    "alias": "dg",
    "name": "Deepgram",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.deepgram.com/v1/listen",
    "models": [
      {
        "id": "nova-3",
        "name": "Nova 3"
      },
      {
        "id": "nova-2",
        "name": "Nova 2"
      },
      {
        "id": "whisper-large",
        "name": "Whisper Large"
      },
      {
        "id": "nova",
        "name": "Nova"
      }
    ]
  },
  {
    "id": "deepseek",
    "alias": "ds",
    "name": "DeepSeek",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.deepseek.com",
    "models": [
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek-v4-pro-max",
        "name": "DeepSeek V4 Pro Max"
      },
      {
        "id": "deepseek-v4-pro-none",
        "name": "DeepSeek V4 Pro No Thinking"
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash"
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "deepseek-v4-flash-vision-exp",
        "name": "DeepSeek V4 Flash Vision (Exp)"
      },
      {
        "id": "deepseek-chat",
        "name": "DeepSeek V3.2 Chat"
      },
      {
        "id": "deepseek-reasoner",
        "name": "DeepSeek V3.2 Reasoner"
      }
    ]
  },
  {
    "id": "deepseek-web",
    "alias": "deepseek-web",
    "name": "DeepSeek Web",
    "category": "webCookie",
    "authMethods": [
      "cookie",
      "api_key"
    ],
    "baseUrl": "https://chat.deepseek.com/api/v0/chat/completion",
    "models": [
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek-v4-pro-think",
        "name": "DeepSeek V4 Pro Think"
      },
      {
        "id": "deepseek-v4-pro-search",
        "name": "DeepSeek V4 Pro Search"
      },
      {
        "id": "deepseek-v4-pro-think-search",
        "name": "DeepSeek V4 Pro Think+Search"
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "deepseek-v4-flash-think",
        "name": "DeepSeek V4 Flash Think"
      },
      {
        "id": "deepseek-v4-flash-search",
        "name": "DeepSeek V4 Flash Search"
      },
      {
        "id": "deepseek-v4-flash-think-search",
        "name": "DeepSeek V4 Flash Think+Search"
      },
      {
        "id": "deepseek-chat",
        "name": "DeepSeek Chat"
      },
      {
        "id": "deepseek-reasoner",
        "name": "DeepSeek Reasoner"
      },
      {
        "id": "DeepSeek-R1",
        "name": "DeepSeek R1"
      },
      {
        "id": "DeepSeek-R1-Search",
        "name": "DeepSeek R1 Search"
      },
      {
        "id": "DeepSeek-V3.2",
        "name": "DeepSeek V3.2"
      },
      {
        "id": "DeepSeek-Search",
        "name": "DeepSeek Search"
      }
    ]
  },
  {
    "id": "devin-cli",
    "alias": "dv",
    "name": "Devin CLI",
    "category": "free",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "swe-1.6-fast",
        "name": "SWE-1.6 Fast"
      },
      {
        "id": "swe-1.6",
        "name": "SWE-1.6"
      },
      {
        "id": "swe-1.5-fast",
        "name": "SWE-1.5 Fast"
      },
      {
        "id": "swe-1.5",
        "name": "SWE-1.5"
      },
      {
        "id": "claude-opus-4.7-max",
        "name": "Claude Opus 4.7 Max"
      },
      {
        "id": "claude-opus-4.7-high",
        "name": "Claude Opus 4.7 High"
      },
      {
        "id": "claude-opus-4.7-medium",
        "name": "Claude Opus 4.7 Medium"
      },
      {
        "id": "claude-opus-4.7-low",
        "name": "Claude Opus 4.7 Low"
      },
      {
        "id": "claude-sonnet-4.6-thinking-1m",
        "name": "Claude Sonnet 4.6 Thinking 1M"
      },
      {
        "id": "claude-sonnet-4.6-thinking",
        "name": "Claude Sonnet 4.6 Thinking"
      },
      {
        "id": "claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "claude-opus-4.6-thinking",
        "name": "Claude Opus 4.6 Thinking"
      },
      {
        "id": "claude-opus-4.6",
        "name": "Claude Opus 4.6"
      },
      {
        "id": "claude-sonnet-4.5",
        "name": "Claude Sonnet 4.5"
      },
      {
        "id": "claude-haiku-4.5",
        "name": "Claude Haiku 4.5"
      },
      {
        "id": "gpt-5.5-xhigh",
        "name": "GPT-5.5 XHigh"
      },
      {
        "id": "gpt-5.5-high",
        "name": "GPT-5.5 High"
      },
      {
        "id": "gpt-5.5-medium",
        "name": "GPT-5.5 Medium"
      },
      {
        "id": "gpt-5.5-low",
        "name": "GPT-5.5 Low"
      },
      {
        "id": "gpt-5.4-high",
        "name": "GPT-5.4 High"
      },
      {
        "id": "gpt-5.4-medium",
        "name": "GPT-5.4 Medium"
      },
      {
        "id": "gpt-5.4-low",
        "name": "GPT-5.4 Low"
      },
      {
        "id": "gpt-5.3-codex-high",
        "name": "GPT-5.3 Codex High"
      },
      {
        "id": "gpt-5.3-codex-medium",
        "name": "GPT-5.3 Codex Medium"
      },
      {
        "id": "gpt-5.3-codex-low",
        "name": "GPT-5.3 Codex Low"
      },
      {
        "id": "gpt-5.2-high",
        "name": "GPT-5.2 High"
      },
      {
        "id": "gpt-5.2-medium",
        "name": "GPT-5.2 Medium"
      },
      {
        "id": "gpt-5.2-low",
        "name": "GPT-5.2 Low"
      },
      {
        "id": "gemini-3.1-pro-high",
        "name": "Gemini 3.1 Pro High"
      },
      {
        "id": "gemini-3.1-pro-low",
        "name": "Gemini 3.1 Pro Low"
      },
      {
        "id": "gemini-3.0-flash-high",
        "name": "Gemini 3 Flash High"
      },
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro"
      },
      {
        "id": "deepseek-v4",
        "name": "DeepSeek V4"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "glm-5.1",
        "name": "GLM-5.1"
      }
    ]
  },
  {
    "id": "edge-tts",
    "alias": "edge-tts",
    "name": "Edge TTS",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Edge TTS Default"
      }
    ]
  },
  {
    "id": "elevenlabs",
    "alias": "el",
    "name": "ElevenLabs",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "scribe_v1",
        "name": "Scribe v1"
      },
      {
        "id": "scribe_v2",
        "name": "Scribe v2"
      }
    ]
  },
  {
    "id": "exa",
    "alias": "exa",
    "name": "Exa",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Exa Default"
      }
    ]
  },
  {
    "id": "fal-ai",
    "alias": "fal",
    "name": "Fal.ai",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "fal-ai/flux/schnell",
        "name": "FLUX Schnell"
      },
      {
        "id": "fal-ai/flux/dev",
        "name": "FLUX Dev"
      },
      {
        "id": "fal-ai/flux-pro/v1.1",
        "name": "FLUX Pro v1.1"
      },
      {
        "id": "fal-ai/flux-pro/v1.1-ultra",
        "name": "FLUX Pro v1.1 Ultra"
      },
      {
        "id": "fal-ai/recraft-v3",
        "name": "Recraft V3"
      },
      {
        "id": "fal-ai/ideogram/v2",
        "name": "Ideogram V2"
      },
      {
        "id": "fal-ai/stable-diffusion-v35-large",
        "name": "SD 3.5 Large"
      }
    ]
  },
  {
    "id": "featherless",
    "alias": "fl",
    "name": "Featherless",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.featherless.ai/v1",
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "zai-org/GLM-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "zai-org/GLM-5.1",
        "name": "GLM 5.1"
      },
      {
        "id": "moonshotai/Kimi-K2.7-Code",
        "name": "Kimi K2.7 Code"
      },
      {
        "id": "moonshotai/Kimi-K2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "moonshotai/Kimi-K2.5",
        "name": "Kimi K2.5"
      }
    ]
  },
  {
    "id": "firecrawl",
    "alias": "firecrawl",
    "name": "Firecrawl",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Firecrawl Default"
      }
    ]
  },
  {
    "id": "fireworks",
    "alias": "fireworks",
    "name": "Fireworks AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "models": [
      {
        "id": "accounts/fireworks/models/deepseek-v3p1",
        "name": "DeepSeek V3.1"
      },
      {
        "id": "accounts/fireworks/models/llama-v3p3-70b-instruct",
        "name": "Llama 3.3 70B"
      },
      {
        "id": "accounts/fireworks/models/qwen3-235b-a22b",
        "name": "Qwen3 235B"
      },
      {
        "id": "nomic-ai/nomic-embed-text-v1.5",
        "name": "Nomic Embed Text v1.5"
      }
    ]
  },
  {
    "id": "fish-audio",
    "alias": "fish",
    "name": "Fish Audio",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Fish Audio Default"
      }
    ]
  },
  {
    "id": "gemini",
    "alias": "gemini",
    "name": "Gemini",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/models",
    "models": [
      {
        "id": "gemini-4-argon",
        "name": "Gemini 4 Argon"
      },
      {
        "id": "gemini-3.8-flash",
        "name": "Gemini 3.8 Flash"
      },
      {
        "id": "gemini-3.7-flash",
        "name": "Gemini 3.7 Flash"
      },
      {
        "id": "gemini-3.6-flash",
        "name": "Gemini 3.6 Flash"
      },
      {
        "id": "gemini-3.5-flash-lite",
        "name": "Gemini 3.5 Flash Lite"
      },
      {
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview"
      },
      {
        "id": "gemini-3.1-flash-lite-preview",
        "name": "Gemini 3.1 Flash Lite Preview"
      },
      {
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview"
      },
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro"
      },
      {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash"
      },
      {
        "id": "gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash Lite"
      },
      {
        "id": "gemma-4-31b-it",
        "name": "Gemma 4 31B IT"
      },
      {
        "id": "gemini-embedding-2-preview",
        "name": "Gemini Embedding 2 Preview"
      },
      {
        "id": "gemini-embedding-001",
        "name": "Gemini Embedding 001"
      },
      {
        "id": "text-embedding-005",
        "name": "Text Embedding 005"
      },
      {
        "id": "text-embedding-004",
        "name": "Text Embedding 004 (Legacy)"
      },
      {
        "id": "gemini-3.1-flash-image-preview",
        "name": "Gemini 3.1 Flash Image (Nano Banana 2)"
      },
      {
        "id": "gemini-3-pro-image-preview",
        "name": "Gemini 3 Pro Image (Nano Banana Pro)"
      },
      {
        "id": "gemini-2.5-flash-image",
        "name": "Gemini 2.5 Flash Image (Nano Banana)"
      },
      {
        "id": "gemini-2.0-flash",
        "name": "Gemini 2.0 Flash"
      },
      {
        "id": "gemini-2.5-flash-native-audio-preview-09-17",
        "name": "Gemini Live Transcription (Realtime)"
      },
      {
        "id": "gemini-3.1-flash-tts-preview",
        "name": "Gemini 3.1 Flash TTS"
      },
      {
        "id": "gemini-2.5-flash-preview-tts",
        "name": "Gemini 2.5 Flash TTS"
      },
      {
        "id": "gemini-2.5-pro-preview-tts",
        "name": "Gemini 2.5 Pro TTS"
      },
      {
        "id": "embedding-001",
        "name": "Embedding 001"
      }
    ]
  },
  {
    "id": "gemini-cli",
    "alias": "gc",
    "name": "Gemini CLI",
    "category": "free",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://cloudcode-pa.googleapis.com/v1internal",
    "models": [
      {
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview"
      },
      {
        "id": "gemini-3-pro-preview",
        "name": "Gemini 3 Pro Preview"
      },
      {
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview"
      },
      {
        "id": "gemini-3.1-flash-lite-preview",
        "name": "Gemini 3.1 Flash Lite Preview"
      },
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro"
      },
      {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash"
      },
      {
        "id": "gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash Lite"
      }
    ]
  },
  {
    "id": "gemini-web",
    "alias": "gemini-web",
    "name": "Gemini Web",
    "category": "webCookie",
    "authMethods": [
      "cookie",
      "api_key"
    ],
    "baseUrl": "https://gemini.google.com/app",
    "models": [
      {
        "id": "gemini-3.1-pro",
        "name": "Gemini 3.1 Pro"
      },
      {
        "id": "gemini-3.7-flash",
        "name": "Gemini 3.7 Flash"
      },
      {
        "id": "gemini-3.1-flash-lite",
        "name": "Gemini 3.1 Flash-Lite"
      },
      {
        "id": "gemini-image",
        "name": "Gemini Image (web)"
      }
    ]
  },
  {
    "id": "github-copilot",
    "alias": "gh",
    "name": "GitHub Copilot",
    "category": "oauth",
    "authMethods": [
      "device_code"
    ],
    "baseUrl": "https://api.githubcopilot.com",
    "models": [
      {
        "id": "gpt-5-mini",
        "name": "GPT-5 Mini"
      },
      {
        "id": "gpt-5.3-codex",
        "name": "GPT-5.3 Codex"
      },
      {
        "id": "gpt-5.4",
        "name": "GPT-5.4"
      },
      {
        "id": "gpt-5.4-mini",
        "name": "GPT-5.4 Mini"
      },
      {
        "id": "gpt-5.5",
        "name": "GPT-5.5"
      },
      {
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna"
      },
      {
        "id": "gpt-5.6-sol",
        "name": "GPT-5.6 Sol"
      },
      {
        "id": "gpt-5.6-terra",
        "name": "GPT-5.6 Terra"
      },
      {
        "id": "gpt-6-astra",
        "name": "GPT-6 Astra"
      },
      {
        "id": "gpt-6-luna",
        "name": "GPT-6 Luna"
      },
      {
        "id": "gpt-6-sol",
        "name": "GPT-6 Sol"
      },
      {
        "id": "gpt-6.1-sol",
        "name": "GPT-6.1 Sol"
      },
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5"
      },
      {
        "id": "claude-fable-5.1",
        "name": "Claude Fable 5.1"
      },
      {
        "id": "claude-haiku-4.5",
        "name": "Claude Haiku 4.5"
      },
      {
        "id": "claude-haiku-5.5",
        "name": "Claude Haiku 5.5"
      },
      {
        "id": "claude-opus-4.8",
        "name": "Claude Opus 4.8"
      },
      {
        "id": "claude-opus-4.8-fast",
        "name": "Claude Opus 4.8 (Fast)"
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5"
      },
      {
        "id": "claude-opus-5.5",
        "name": "Claude Opus 5.5"
      },
      {
        "id": "claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5"
      },
      {
        "id": "claude-sonnet-5.5",
        "name": "Claude Sonnet 5.5"
      },
      {
        "id": "gemini-3.7-flash",
        "name": "Gemini 3.7 Flash"
      },
      {
        "id": "gemini-3.8-flash",
        "name": "Gemini 3.8 Flash"
      },
      {
        "id": "gemini-4-argon",
        "name": "Gemini 4 Argon"
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3"
      },
      {
        "id": "mai-code-1.1-flash",
        "name": "MAI-Code-1.1-Flash"
      },
      {
        "id": "text-embedding-3-small",
        "name": "Text Embedding 3 Small (GitHub)"
      },
      {
        "id": "text-embedding-ada-002",
        "name": "Text Embedding Ada 002 (GitHub)"
      }
    ]
  },
  {
    "id": "gitlab",
    "alias": "gitlab",
    "name": "GitLab Duo",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://gitlab.com/api/v4",
    "models": [
      {
        "id": "default",
        "name": "GitLab Duo Default"
      }
    ]
  },
  {
    "id": "glm-cn",
    "alias": "glm-cn",
    "name": "GLM (China)",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "models": [
      {
        "id": "glm-5.3",
        "name": "GLM 5.3"
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM 5.3 Flash (Vision)"
      },
      {
        "id": "glm-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "glm-5.1",
        "name": "GLM 5.1"
      },
      {
        "id": "glm-5-turbo",
        "name": "GLM 5 Turbo"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "glm-4.7",
        "name": "GLM-4.7"
      },
      {
        "id": "glm-4.6v",
        "name": "GLM 4.6V (Vision)"
      },
      {
        "id": "glm-4.6",
        "name": "GLM-4.6"
      },
      {
        "id": "glm-4.5-air",
        "name": "GLM-4.5-Air"
      }
    ]
  },
  {
    "id": "google-pse",
    "alias": "gpse",
    "name": "Google PSE",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Google PSE Default"
      }
    ]
  },
  {
    "id": "google-tts",
    "alias": "google-tts",
    "name": "Google TTS",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Google TTS Default"
      }
    ]
  },
  {
    "id": "grok-cli",
    "alias": "gcli",
    "name": "Grok CLI (Grok Build)",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.x.ai/v1",
    "models": [
      {
        "id": "GROK_CLI_MODEL",
        "name": "Grok Build"
      },
      {
        "id": "grok-4.7",
        "name": "Grok 4.7"
      },
      {
        "id": "grok-4.5",
        "name": "Grok 4.5"
      },
      {
        "id": "grok-4.5-high",
        "name": "Grok 4.5 (High)"
      },
      {
        "id": "grok-4.5-medium",
        "name": "Grok 4.5 (Medium)"
      },
      {
        "id": "grok-4.5-low",
        "name": "Grok 4.5 (Low)"
      }
    ]
  },
  {
    "id": "grok-web",
    "alias": "gw",
    "name": "Grok Web (Subscription)",
    "category": "webCookie",
    "authMethods": [
      "cookie",
      "api_key"
    ],
    "baseUrl": "https://grok.com/rest/app-chat/conversations/new",
    "models": [
      {
        "id": "grok-image",
        "name": "Grok Imagine Image"
      },
      {
        "id": "grok-video",
        "name": "Grok Imagine Video"
      },
      {
        "id": "grok-3",
        "name": "Grok 3"
      },
      {
        "id": "grok-3-mini",
        "name": "Grok 3 Mini (Thinking)"
      },
      {
        "id": "grok-3-thinking",
        "name": "Grok 3 Thinking"
      },
      {
        "id": "grok-4",
        "name": "Grok 4"
      },
      {
        "id": "grok-4-mini",
        "name": "Grok 4 Mini (Thinking)"
      },
      {
        "id": "grok-4-thinking",
        "name": "Grok 4 Thinking"
      },
      {
        "id": "grok-4-heavy",
        "name": "Grok 4 Heavy (SuperGrok)"
      },
      {
        "id": "grok-4.1-mini",
        "name": "Grok 4.1 Mini (Thinking)"
      },
      {
        "id": "grok-4.1-fast",
        "name": "Grok 4.1 Fast"
      },
      {
        "id": "grok-4.1-expert",
        "name": "Grok 4.1 Expert"
      },
      {
        "id": "grok-4.1-thinking",
        "name": "Grok 4.1 Thinking"
      },
      {
        "id": "grok-4.2",
        "name": "Grok 4.2 (4.20 Beta)"
      }
    ]
  },
  {
    "id": "groq",
    "alias": "groq",
    "name": "Groq",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.groq.com/openai/v1",
    "models": [
      {
        "id": "llama-3.3-70b-versatile",
        "name": "Llama 3.3 70B"
      },
      {
        "id": "meta-llama/llama-4-maverick-17b-128e-instruct",
        "name": "Llama 4 Maverick"
      },
      {
        "id": "qwen/qwen3-32b",
        "name": "Qwen3 32B"
      },
      {
        "id": "openai/gpt-oss-120b",
        "name": "GPT-OSS 120B"
      },
      {
        "id": "whisper-large-v3",
        "name": "Whisper Large v3"
      },
      {
        "id": "whisper-large-v3-turbo",
        "name": "Whisper Large v3 Turbo"
      },
      {
        "id": "distil-whisper-large-v3-en",
        "name": "Distil Whisper Large v3 EN"
      }
    ]
  },
  {
    "id": "huggingface",
    "alias": "hf",
    "name": "HuggingFace",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://router.huggingface.co/v1",
    "models": [
      {
        "id": "black-forest-labs/FLUX.1-schnell",
        "name": "FLUX.1 Schnell"
      },
      {
        "id": "black-forest-labs/FLUX.1-dev",
        "name": "FLUX.1 Dev"
      },
      {
        "id": "black-forest-labs/FLUX.1-Krea-dev",
        "name": "FLUX.1 Krea"
      },
      {
        "id": "black-forest-labs/FLUX.1-Kontext-dev",
        "name": "FLUX.1 Kontext"
      },
      {
        "id": "black-forest-labs/FLUX.2-dev",
        "name": "FLUX.2 Dev"
      },
      {
        "id": "black-forest-labs/FLUX.2-klein-9B",
        "name": "FLUX.2 Klein 9B"
      },
      {
        "id": "black-forest-labs/FLUX.2-klein-4B",
        "name": "FLUX.2 Klein 4B"
      },
      {
        "id": "black-forest-labs/FLUX.2-klein-base-9B",
        "name": "FLUX.2 Klein Base 9B"
      },
      {
        "id": "black-forest-labs/FLUX.2-klein-base-4B",
        "name": "FLUX.2 Klein Base 4B"
      },
      {
        "id": "stabilityai/stable-diffusion-xl-base-1.0",
        "name": "SDXL Base 1.0"
      },
      {
        "id": "stabilityai/stable-diffusion-3.5-large",
        "name": "Stable Diffusion 3.5 Large"
      },
      {
        "id": "stabilityai/stable-diffusion-3.5-large-turbo",
        "name": "Stable Diffusion 3.5 Large Turbo"
      },
      {
        "id": "Qwen/Qwen-Image",
        "name": "Qwen Image"
      },
      {
        "id": "Qwen/Qwen-Image-2512",
        "name": "Qwen Image 2512"
      },
      {
        "id": "Qwen/Qwen-Image-Edit",
        "name": "Qwen Image Edit"
      },
      {
        "id": "Qwen/Qwen-Image-Edit-2509",
        "name": "Qwen Image Edit 2509"
      },
      {
        "id": "Qwen/Qwen-Image-Edit-2511",
        "name": "Qwen Image Edit 2511"
      },
      {
        "id": "ideogram-ai/ideogram-4-fp8",
        "name": "Ideogram 4"
      },
      {
        "id": "tencent/HunyuanImage-3.0",
        "name": "HunyuanImage 3.0"
      },
      {
        "id": "Tongyi-MAI/Z-Image-Turbo",
        "name": "Z-Image Turbo"
      },
      {
        "id": "krea/Krea-2-Turbo",
        "name": "Krea 2 Turbo"
      },
      {
        "id": "HiDream-ai/HiDream-I1-Fast",
        "name": "HiDream I1 Fast"
      },
      {
        "id": "playgroundai/playground-v2.5-1024px-aesthetic",
        "name": "Playground v2.5"
      },
      {
        "id": "openai/whisper-large-v3",
        "name": "Whisper Large v3 (HF)"
      },
      {
        "id": "openai/whisper-large-v3-turbo",
        "name": "Whisper Large v3 Turbo (HF)"
      }
    ]
  },
  {
    "id": "hyperbolic",
    "alias": "hyp",
    "name": "Hyperbolic",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.hyperbolic.xyz/v1",
    "models": [
      {
        "id": "Qwen/QwQ-32B",
        "name": "QwQ 32B"
      },
      {
        "id": "deepseek-ai/DeepSeek-R1",
        "name": "DeepSeek R1"
      },
      {
        "id": "deepseek-ai/DeepSeek-V3",
        "name": "DeepSeek V3"
      },
      {
        "id": "meta-llama/Llama-3.3-70B-Instruct",
        "name": "Llama 3.3 70B"
      },
      {
        "id": "meta-llama/Llama-3.2-3B-Instruct",
        "name": "Llama 3.2 3B"
      },
      {
        "id": "Qwen/Qwen2.5-72B-Instruct",
        "name": "Qwen 2.5 72B"
      },
      {
        "id": "Qwen/Qwen2.5-Coder-32B-Instruct",
        "name": "Qwen 2.5 Coder 32B"
      },
      {
        "id": "NousResearch/Hermes-3-Llama-3.1-70B",
        "name": "Hermes 3 70B"
      }
    ]
  },
  {
    "id": "iflow",
    "alias": "if",
    "name": "iFlow AI",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://apis.iflow.cn/v1",
    "models": [
      {
        "id": "qwen3-coder-plus",
        "name": "Qwen3 Coder Plus"
      },
      {
        "id": "qwen3-max",
        "name": "Qwen3 Max"
      },
      {
        "id": "qwen3-vl-plus",
        "name": "Qwen3 VL Plus"
      },
      {
        "id": "qwen3-max-preview",
        "name": "Qwen3 Max Preview"
      },
      {
        "id": "qwen3-235b",
        "name": "Qwen3 235B A22B"
      },
      {
        "id": "qwen3-235b-a22b-instruct",
        "name": "Qwen3 235B A22B Instruct"
      },
      {
        "id": "qwen3-235b-a22b-thinking-2507",
        "name": "Qwen3 235B A22B Thinking"
      },
      {
        "id": "qwen3-32b",
        "name": "Qwen3 32B"
      },
      {
        "id": "kimi-k2",
        "name": "Kimi K2"
      },
      {
        "id": "deepseek-v3.2",
        "name": "DeepSeek V3.2 Exp"
      },
      {
        "id": "deepseek-v3.1",
        "name": "DeepSeek V3.1 Terminus"
      },
      {
        "id": "deepseek-v3",
        "name": "DeepSeek V3 671B"
      },
      {
        "id": "deepseek-r1",
        "name": "DeepSeek R1"
      },
      {
        "id": "glm-4.7",
        "name": "GLM 4.7"
      },
      {
        "id": "iflow-rome-30ba3b",
        "name": "iFlow ROME"
      }
    ]
  },
  {
    "id": "inworld",
    "alias": "inworld",
    "name": "Inworld TTS",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Inworld TTS Default"
      }
    ]
  },
  {
    "id": "jina-ai",
    "alias": "jina",
    "name": "Jina AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Jina AI Default"
      }
    ]
  },
  {
    "id": "jina-reader",
    "alias": "jina-reader",
    "name": "Jina Reader",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Jina Reader Default"
      }
    ]
  },
  {
    "id": "kilocode",
    "alias": "kc",
    "name": "Kilo Code",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.kilo.ai/api/openrouter/v1",
    "models": [
      {
        "id": "anthropic/claude-sonnet-4-20250514",
        "name": "Claude Sonnet 4"
      },
      {
        "id": "anthropic/claude-opus-4-20250514",
        "name": "Claude Opus 4"
      },
      {
        "id": "google/gemini-2.5-pro",
        "name": "Gemini 2.5 Pro"
      },
      {
        "id": "google/gemini-2.5-flash",
        "name": "Gemini 2.5 Flash"
      },
      {
        "id": "openai/gpt-4.1",
        "name": "GPT-4.1"
      },
      {
        "id": "openai/o3",
        "name": "o3"
      },
      {
        "id": "deepseek/deepseek-chat",
        "name": "DeepSeek Chat"
      },
      {
        "id": "deepseek/deepseek-reasoner",
        "name": "DeepSeek Reasoner"
      }
    ]
  },
  {
    "id": "kilo-gateway",
    "alias": "kgw",
    "name": "Kilo Gateway",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.kilo.ai/api/gateway/v1",
    "models": [
      {
        "id": "kilo-auto/free",
        "name": "Kilo Auto Free"
      },
      {
        "id": "nvidia/nemotron-3-super-120b-a12b:free",
        "name": "Nemotron 3 Super 120B (Free)"
      },
      {
        "id": "nvidia/nemotron-3-ultra-550b-a55b:free",
        "name": "Nemotron 3 Ultra 550B (Free)"
      },
      {
        "id": "kwaipilot/kat-coder-pro-v2.5:free",
        "name": "Kat Coder Pro v2.5 (Free)"
      },
      {
        "id": "kilo-auto/frontier",
        "name": "Kilo Auto Frontier"
      },
      {
        "id": "kilo-auto/balanced",
        "name": "Kilo Auto Balanced"
      }
    ]
  },
  {
    "id": "kimchi",
    "alias": "kimchi",
    "name": "Kimchi",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://llm.kimchi.dev/openai/v1",
    "models": [
      {
        "id": "minimax-m3",
        "name": "MiniMax-M3"
      },
      {
        "id": "kimi-k2.7",
        "name": "Kimi-K2.7"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi-K2.6"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi-K2.5"
      },
      {
        "id": "nemotron-3-ultra-fp4",
        "name": "Nemotron 3 Ultra FP4"
      },
      {
        "id": "minimax-m2.7",
        "name": "MiniMax-M2.7"
      },
      {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6"
      },
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6"
      }
    ]
  },
  {
    "id": "kimi",
    "alias": "kimi",
    "name": "Kimi",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.kimi.com/coding/v1",
    "models": [
      {
        "id": "kimi-k3",
        "name": "Kimi K3"
      },
      {
        "id": "k3",
        "name": "Kimi K3 (Code)"
      },
      {
        "id": "kimi-for-coding",
        "name": "Kimi for Coding"
      },
      {
        "id": "kimi-for-coding-highspeed",
        "name": "Kimi for Coding Highspeed"
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code"
      },
      {
        "id": "kimi-k2.7-code-highspeed",
        "name": "Kimi K2.7 Code Highspeed"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "kimi-k2.5-thinking",
        "name": "Kimi K2.5 Thinking"
      },
      {
        "id": "kimi-latest",
        "name": "Kimi Latest"
      }
    ]
  },
  {
    "id": "kiro",
    "alias": "kr",
    "name": "Kiro AI",
    "category": "free",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    "models": [
      {
        "id": "claude-opus-5.5",
        "name": "Claude Opus 5.5"
      },
      {
        "id": "claude-opus-5.5-thinking",
        "name": "Claude Opus 5.5 (Thinking)"
      },
      {
        "id": "claude-opus-5.5-agentic",
        "name": "Claude Opus 5.5 (Agentic)"
      },
      {
        "id": "claude-opus-5.5-thinking-agentic",
        "name": "Claude Opus 5.5 (Thinking + Agentic)"
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5"
      },
      {
        "id": "claude-opus-5-thinking",
        "name": "Claude Opus 5 (Thinking)"
      },
      {
        "id": "claude-opus-5-agentic",
        "name": "Claude Opus 5 (Agentic)"
      },
      {
        "id": "claude-opus-5-thinking-agentic",
        "name": "Claude Opus 5 (Thinking + Agentic)"
      },
      {
        "id": "claude-opus-4.8",
        "name": "Claude Opus 4.8"
      },
      {
        "id": "claude-opus-4.8-thinking",
        "name": "Claude Opus 4.8 (Thinking)"
      },
      {
        "id": "claude-opus-4.8-agentic",
        "name": "Claude Opus 4.8 (Agentic)"
      },
      {
        "id": "claude-opus-4.8-thinking-agentic",
        "name": "Claude Opus 4.8 (Thinking + Agentic)"
      },
      {
        "id": "claude-opus-4.7",
        "name": "Claude Opus 4.7"
      },
      {
        "id": "claude-opus-4.7-thinking",
        "name": "Claude Opus 4.7 (Thinking)"
      },
      {
        "id": "claude-opus-4.7-agentic",
        "name": "Claude Opus 4.7 (Agentic)"
      },
      {
        "id": "claude-opus-4.7-thinking-agentic",
        "name": "Claude Opus 4.7 (Thinking + Agentic)"
      },
      {
        "id": "claude-opus-4.5",
        "name": "Claude Opus 4.5"
      },
      {
        "id": "claude-opus-4.5-thinking",
        "name": "Claude Opus 4.5 (Thinking)"
      },
      {
        "id": "claude-opus-4.5-agentic",
        "name": "Claude Opus 4.5 (Agentic)"
      },
      {
        "id": "claude-opus-4.5-thinking-agentic",
        "name": "Claude Opus 4.5 (Thinking + Agentic)"
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5"
      },
      {
        "id": "claude-sonnet-4.5",
        "name": "Claude Sonnet 4.5"
      },
      {
        "id": "claude-haiku-4.5",
        "name": "Claude Haiku 4.5"
      },
      {
        "id": "deepseek-3.2",
        "name": "DeepSeek 3.2"
      },
      {
        "id": "qwen3-coder-next",
        "name": "Qwen3 Coder Next"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "gpt-5.6-sol",
        "name": "GPT 5.6 Sol"
      },
      {
        "id": "gpt-5.6-terra",
        "name": "GPT 5.6 Terra"
      },
      {
        "id": "gpt-5.6-luna",
        "name": "GPT 5.6 Luna"
      },
      {
        "id": "claude-sonnet-5-thinking",
        "name": "Claude Sonnet 5 (Thinking)"
      },
      {
        "id": "claude-sonnet-4.5-thinking",
        "name": "Claude Sonnet 4.5 (Thinking)"
      },
      {
        "id": "claude-haiku-4.5-thinking",
        "name": "Claude Haiku 4.5 (Thinking)"
      },
      {
        "id": "gpt-5.6-sol-thinking",
        "name": "GPT 5.6 Sol (Thinking)"
      },
      {
        "id": "gpt-5.6-terra-thinking",
        "name": "GPT 5.6 Terra (Thinking)"
      },
      {
        "id": "gpt-5.6-luna-thinking",
        "name": "GPT 5.6 Luna (Thinking)"
      },
      {
        "id": "claude-sonnet-5-agentic",
        "name": "Claude Sonnet 5 (Agentic)"
      },
      {
        "id": "claude-sonnet-4.5-agentic",
        "name": "Claude Sonnet 4.5 (Agentic)"
      },
      {
        "id": "claude-haiku-4.5-agentic",
        "name": "Claude Haiku 4.5 (Agentic)"
      },
      {
        "id": "gpt-5.6-sol-agentic",
        "name": "GPT 5.6 Sol (Agentic)"
      },
      {
        "id": "gpt-5.6-terra-agentic",
        "name": "GPT 5.6 Terra (Agentic)"
      },
      {
        "id": "gpt-5.6-luna-agentic",
        "name": "GPT 5.6 Luna (Agentic)"
      },
      {
        "id": "claude-sonnet-5-thinking-agentic",
        "name": "Claude Sonnet 5 (Thinking + Agentic)"
      },
      {
        "id": "claude-sonnet-4.5-thinking-agentic",
        "name": "Claude Sonnet 4.5 (Thinking + Agentic)"
      },
      {
        "id": "claude-haiku-4.5-thinking-agentic",
        "name": "Claude Haiku 4.5 (Thinking + Agentic)"
      },
      {
        "id": "gpt-5.6-sol-thinking-agentic",
        "name": "GPT 5.6 Sol (Thinking + Agentic)"
      },
      {
        "id": "gpt-5.6-terra-thinking-agentic",
        "name": "GPT 5.6 Terra (Thinking + Agentic)"
      },
      {
        "id": "gpt-5.6-luna-thinking-agentic",
        "name": "GPT 5.6 Luna (Thinking + Agentic)"
      }
    ]
  },
  {
    "id": "linkup",
    "alias": "linkup",
    "name": "Linkup",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Linkup Default"
      }
    ]
  },
  {
    "id": "llm7",
    "alias": "llm7",
    "name": "LLM7",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.llm7.io/v1",
    "models": [
      {
        "id": "gpt-5.5",
        "name": "GPT-5.5 (LLM7)"
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5 (LLM7)"
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash (LLM7)"
      },
      {
        "id": "grok-4.5",
        "name": "Grok 4.5 (LLM7)"
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3 (LLM7)"
      }
    ]
  },
  {
    "id": "local-device",
    "alias": "local-device",
    "name": "Local Device",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Local Device Default"
      }
    ]
  },
  {
    "id": "mimo-free",
    "alias": "mmf",
    "name": "MiMo Code Free",
    "category": "free",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.xiaomimimo.com/api/free-ai/openai/chat",
    "models": [
      {
        "id": "mimo-auto",
        "name": "MiMo Auto"
      }
    ]
  },
  {
    "id": "minimax-cn",
    "alias": "minimax-cn",
    "name": "Minimax (China)",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.minimaxi.com/anthropic/v1",
    "models": [
      {
        "id": "MiniMax-M3",
        "name": "MiniMax M3"
      },
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "MiniMax-M2.1",
        "name": "MiniMax M2.1"
      },
      {
        "id": "speech-2.8-hd",
        "name": "Speech 2.8 HD"
      },
      {
        "id": "speech-2.8-turbo",
        "name": "Speech 2.8 Turbo"
      },
      {
        "id": "speech-2.6-hd",
        "name": "Speech 2.6 HD"
      },
      {
        "id": "speech-2.6-turbo",
        "name": "Speech 2.6 Turbo"
      },
      {
        "id": "speech-02-hd",
        "name": "Speech 02 HD"
      },
      {
        "id": "speech-02-turbo",
        "name": "Speech 02 Turbo"
      },
      {
        "id": "speech-01-hd",
        "name": "Speech 01 HD"
      },
      {
        "id": "speech-01-turbo",
        "name": "Speech 01 Turbo"
      }
    ]
  },
  {
    "id": "minimax-code",
    "alias": "mm",
    "name": "MiniMax Code",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://agent.minimax.cn/mavis/api/v1/llm/v1",
    "models": [
      {
        "id": "MiniMax-M3.1-Flash-Preview",
        "name": "MiniMax M3.1 Flash Preview"
      },
      {
        "id": "MiniMax-M3",
        "name": "MiniMax M3"
      },
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "MiniMax-M2.7-highspeed",
        "name": "MiniMax M2.7 Highspeed"
      }
    ]
  },
  {
    "id": "minimax-code-global",
    "alias": "mmg",
    "name": "MiniMax Code (Global)",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://agent.minimax.io/mavis/api/v1/llm/v1",
    "models": [
      {
        "id": "MiniMax-M3.1-Flash-Preview",
        "name": "MiniMax M3.1 Flash Preview"
      },
      {
        "id": "MiniMax-M3",
        "name": "MiniMax M3"
      },
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "MiniMax-M2.7-highspeed",
        "name": "MiniMax M2.7 Highspeed"
      }
    ]
  },
  {
    "id": "minimax",
    "alias": "minimax",
    "name": "Minimax Coding",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.minimax.io/anthropic/v1",
    "models": [
      {
        "id": "MiniMax-M3",
        "name": "MiniMax M3"
      },
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "MiniMax-M2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "MiniMax-M2.1",
        "name": "MiniMax M2.1"
      },
      {
        "id": "minimax-image-01",
        "name": "MiniMax Image 01"
      },
      {
        "id": "speech-2.8-hd",
        "name": "Speech 2.8 HD"
      },
      {
        "id": "speech-2.8-turbo",
        "name": "Speech 2.8 Turbo"
      },
      {
        "id": "speech-2.6-hd",
        "name": "Speech 2.6 HD"
      },
      {
        "id": "speech-2.6-turbo",
        "name": "Speech 2.6 Turbo"
      },
      {
        "id": "speech-02-hd",
        "name": "Speech 02 HD"
      },
      {
        "id": "speech-02-turbo",
        "name": "Speech 02 Turbo"
      },
      {
        "id": "speech-01-hd",
        "name": "Speech 01 HD"
      },
      {
        "id": "speech-01-turbo",
        "name": "Speech 01 Turbo"
      }
    ]
  },
  {
    "id": "mistral",
    "alias": "mistral",
    "name": "Mistral",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.mistral.ai/v1",
    "models": [
      {
        "id": "mistral-large-latest",
        "name": "Mistral Large 3"
      },
      {
        "id": "codestral-latest",
        "name": "Codestral"
      },
      {
        "id": "mistral-medium-latest",
        "name": "Mistral Medium 3"
      },
      {
        "id": "mistral-embed",
        "name": "Mistral Embed"
      }
    ]
  },
  {
    "id": "mmf",
    "alias": "mmf",
    "name": "MMF",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.xiaomimimo.com/api/free-ai/openai/chat",
    "models": [
      {
        "id": "mimo-auto",
        "name": "MiMo Auto"
      }
    ]
  },
  {
    "id": "morph",
    "alias": "morph",
    "name": "Morph",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.morphllm.com/v1",
    "models": [
      {
        "id": "morph-v3-large",
        "name": "Morph v3 Large"
      },
      {
        "id": "morph-v3-fast",
        "name": "Morph v3 Fast"
      },
      {
        "id": "morph-qwen35-397b",
        "name": "Qwen 3.5 397B (Morph)"
      },
      {
        "id": "morph-minimax27-230b",
        "name": "MiniMax M2.7 (Morph)"
      },
      {
        "id": "morph-qwen36-27b",
        "name": "Qwen 3.6 27B (Morph)"
      },
      {
        "id": "morph-dsv4flash",
        "name": "DeepSeek V4 Flash (Morph)"
      }
    ]
  },
  {
    "id": "muse",
    "alias": "muse",
    "name": "Muse (Meta Model API)",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.meta.ai/v1",
    "models": [
      {
        "id": "muse-spark-1.3",
        "name": "Muse Spark 1.3"
      },
      {
        "id": "muse-spark-1.2",
        "name": "Muse Spark 1.2"
      },
      {
        "id": "muse-spark-1.1",
        "name": "Muse Spark 1.1"
      },
      {
        "id": "muse-spark-1.3-contributor",
        "name": "Muse Spark 1.3 Contributor"
      },
      {
        "id": "muse-spark-1.2-contributor",
        "name": "Muse Spark 1.2 Contributor"
      }
    ]
  },
  {
    "id": "muse-web",
    "alias": "muse-web",
    "name": "Muse Web",
    "category": "webCookie",
    "authMethods": [
      "cookie",
      "api_key"
    ],
    "baseUrl": "https://muse.ai",
    "models": [
      {
        "id": "muse-chat",
        "name": "Muse Chat"
      },
      {
        "id": "muse-image",
        "name": "Muse Image"
      },
      {
        "id": "muse-video",
        "name": "Muse Video"
      }
    ]
  },
  {
    "id": "nace",
    "alias": "nace",
    "name": "Nace Drex",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "drex-max",
        "name": "Drex Max"
      },
      {
        "id": "drex-v2.0",
        "name": "Drex 2.0"
      }
    ]
  },
  {
    "id": "nanobanana",
    "alias": "nb",
    "name": "NanoBanana API",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.nanobananaapi.ai/v1",
    "models": [
      {
        "id": "nanobanana-flash",
        "name": "NanoBanana Flash"
      },
      {
        "id": "nanobanana-pro",
        "name": "NanoBanana Pro"
      }
    ]
  },
  {
    "id": "nebius",
    "alias": "nebius",
    "name": "Nebius AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.studio.nebius.ai/v1",
    "models": [
      {
        "id": "meta-llama/Llama-3.3-70B-Instruct",
        "name": "Llama 3.3 70B Instruct"
      },
      {
        "id": "Qwen/Qwen3-Embedding-8B",
        "name": "Qwen3 Embedding 8B"
      }
    ]
  },
  {
    "id": "nous",
    "alias": "nous",
    "name": "Nous Research",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://inference-api.nousresearch.com/v1",
    "models": [
      {
        "id": "meituan/longcat-2.0:free",
        "name": "Meituan: LongCat 2.0"
      },
      {
        "id": "meituan/longcat-2.5-preview:free",
        "name": "Meituan: LongCat 2.5 Preview"
      },
      {
        "id": "stepfun/step-5-preview:free",
        "name": "StepFun: Step 5 Preview"
      },
      {
        "id": "upstage/solar-mini4:free",
        "name": "Upstage: Solar Mini 4"
      },
      {
        "id": "stepfun/step-3.7-flash:free",
        "name": "StepFun: Step 3.7 Flash"
      },
      {
        "id": "poolside/laguna-s-2.1:free",
        "name": "Poolside: Laguna S 2.1"
      },
      {
        "id": "poolside/laguna-xs-2.1:free",
        "name": "Poolside: Laguna XS 2.1"
      },
      {
        "id": "stealth/missingno",
        "name": "MissingNo"
      }
    ]
  },
  {
    "id": "nvidia",
    "alias": "nvidia",
    "name": "NVIDIA NIM",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "models": [
      {
        "id": "minimaxai/minimax-m2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "minimaxai/minimax-m3",
        "name": "MiniMax M3"
      },
      {
        "id": "z-ai/glm-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "deepseek-ai/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek-ai/deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "moonshotai/kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "nvidia/nemotron-3-ultra-550b-a55b",
        "name": "Nemotron 3 Ultra"
      },
      {
        "id": "nvidia/nv-embedqa-e5-v5",
        "name": "NV EmbedQA E5 v5"
      },
      {
        "id": "nvidia/parakeet-ctc-1.1b-asr",
        "name": "Parakeet CTC 1.1B"
      },
      {
        "id": "fastpitch",
        "name": "FastPitch"
      },
      {
        "id": "tacotron2",
        "name": "Tacotron2"
      }
    ]
  },
  {
    "id": "ollama",
    "alias": "ollama",
    "name": "Ollama Cloud",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://ollama.com/v1",
    "models": [
      {
        "id": "gpt-oss:120b",
        "name": "GPT OSS 120B"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "minimax-m2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "glm-4.7-flash",
        "name": "GLM 4.7 Flash"
      },
      {
        "id": "qwen3.5",
        "name": "Qwen3.5"
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax M3"
      },
      {
        "id": "deepseek-v4.1-flash:cloud",
        "name": "DeepSeek V4.1 Flash"
      },
      {
        "id": "clef",
        "name": "Clef"
      },
      {
        "id": "clef-flash",
        "name": "Clef Flash"
      },
      {
        "id": "clef:cloud",
        "name": "Clef (Cloud)"
      }
    ]
  },
  {
    "id": "ollama-local",
    "alias": "ollama-local",
    "name": "Ollama Local",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "http://localhost:11434/v1",
    "models": [
      {
        "id": "llama3.3",
        "name": "Llama 3.3"
      },
      {
        "id": "qwen2.5-coder",
        "name": "Qwen 2.5 Coder"
      },
      {
        "id": "clef",
        "name": "Clef"
      },
      {
        "id": "clef-flash",
        "name": "Clef Flash"
      },
      {
        "id": "phonon:latest",
        "name": "Phonon (Latest)"
      },
      {
        "id": "phonon",
        "name": "Phonon"
      },
      {
        "id": "phonon:multilingual",
        "name": "Phonon Multilingual"
      },
      {
        "id": "phonon:40m-multilingual",
        "name": "Phonon 40M Multilingual"
      },
      {
        "id": "phonon:en",
        "name": "Phonon English"
      },
      {
        "id": "phonon:31m-en",
        "name": "Phonon 31M English"
      },
      {
        "id": "phonon:40m-en",
        "name": "Phonon 40M English"
      },
      {
        "id": "phonon:de",
        "name": "Phonon German"
      },
      {
        "id": "phonon:40m-de",
        "name": "Phonon 40M German"
      },
      {
        "id": "phonon:es",
        "name": "Phonon Spanish"
      },
      {
        "id": "phonon:40m-es",
        "name": "Phonon 40M Spanish"
      },
      {
        "id": "phonon:fr",
        "name": "Phonon French"
      },
      {
        "id": "phonon:40m-fr",
        "name": "Phonon 40M French"
      },
      {
        "id": "phonon:pt",
        "name": "Phonon Portuguese"
      },
      {
        "id": "phonon:40m-pt",
        "name": "Phonon 40M Portuguese"
      },
      {
        "id": "nomic-embed-text",
        "name": "Nomic Embed Text"
      },
      {
        "id": "nomic-embed-text:latest",
        "name": "Nomic Embed Text (Latest)"
      },
      {
        "id": "nomic-embed-text:v1.5",
        "name": "Nomic Embed Text v1.5"
      },
      {
        "id": "nomic-embed-text:137m-v1.5-fp16",
        "name": "Nomic Embed Text 137M v1.5 (FP16)"
      },
      {
        "id": "nomic-embed-text-v2-moe",
        "name": "Nomic Embed Text v2 MoE"
      },
      {
        "id": "nomic-embed-text-v2-moe:latest",
        "name": "Nomic Embed Text v2 MoE (Latest)"
      },
      {
        "id": "qwen3-embedding",
        "name": "Qwen3 Embedding"
      },
      {
        "id": "qwen3-embedding:latest",
        "name": "Qwen3 Embedding (Latest)"
      },
      {
        "id": "qwen3-embedding:8b",
        "name": "Qwen3 Embedding 8B"
      },
      {
        "id": "qwen3-embedding:8b-q4_K_M",
        "name": "Qwen3 Embedding 8B (Q4_K_M)"
      },
      {
        "id": "qwen3-embedding:8b-q8_0",
        "name": "Qwen3 Embedding 8B (Q8_0)"
      },
      {
        "id": "qwen3-embedding:8b-fp16",
        "name": "Qwen3 Embedding 8B (FP16)"
      },
      {
        "id": "qwen3-embedding:4b",
        "name": "Qwen3 Embedding 4B"
      },
      {
        "id": "qwen3-embedding:4b-q4_K_M",
        "name": "Qwen3 Embedding 4B (Q4_K_M)"
      },
      {
        "id": "qwen3-embedding:4b-q8_0",
        "name": "Qwen3 Embedding 4B (Q8_0)"
      },
      {
        "id": "qwen3-embedding:4b-fp16",
        "name": "Qwen3 Embedding 4B (FP16)"
      },
      {
        "id": "qwen3-embedding:0.6b",
        "name": "Qwen3 Embedding 0.6B"
      },
      {
        "id": "qwen3-embedding:0.6b-q8_0",
        "name": "Qwen3 Embedding 0.6B (Q8_0)"
      },
      {
        "id": "qwen3-embedding:0.6b-fp16",
        "name": "Qwen3 Embedding 0.6B (FP16)"
      },
      {
        "id": "bge-m3",
        "name": "BGE M3"
      },
      {
        "id": "bge-m3:latest",
        "name": "BGE M3 (Latest)"
      },
      {
        "id": "bge-m3:567m",
        "name": "BGE M3 567M"
      },
      {
        "id": "bge-m3:567m-fp16",
        "name": "BGE M3 567M (FP16)"
      },
      {
        "id": "bge-large",
        "name": "BGE Large"
      },
      {
        "id": "bge-large:latest",
        "name": "BGE Large (Latest)"
      },
      {
        "id": "bge-large:335m",
        "name": "BGE Large 335M"
      },
      {
        "id": "bge-large:335m-en-v1.5-fp16",
        "name": "BGE Large 335M EN v1.5 (FP16)"
      },
      {
        "id": "mxbai-embed-large",
        "name": "mxbai Embed Large"
      },
      {
        "id": "mxbai-embed-large:latest",
        "name": "mxbai Embed Large (Latest)"
      },
      {
        "id": "mxbai-embed-large:335m",
        "name": "mxbai Embed Large 335M"
      },
      {
        "id": "mxbai-embed-large:v1",
        "name": "mxbai Embed Large v1"
      },
      {
        "id": "mxbai-embed-large:335m-v1-fp16",
        "name": "mxbai Embed Large 335M v1 (FP16)"
      },
      {
        "id": "embeddinggemma",
        "name": "EmbeddingGemma"
      },
      {
        "id": "embeddinggemma:latest",
        "name": "EmbeddingGemma (Latest)"
      },
      {
        "id": "embeddinggemma:300m",
        "name": "EmbeddingGemma 300M"
      },
      {
        "id": "embeddinggemma:300m-bf16",
        "name": "EmbeddingGemma 300M (BF16)"
      },
      {
        "id": "embeddinggemma:300m-qat-q4_0",
        "name": "EmbeddingGemma 300M (QAT Q4_0)"
      },
      {
        "id": "embeddinggemma:300m-qat-q8_0",
        "name": "EmbeddingGemma 300M (QAT Q8_0)"
      },
      {
        "id": "embeddinggemma-2",
        "name": "EmbeddingGemma 2"
      },
      {
        "id": "embeddinggemma-2:latest",
        "name": "EmbeddingGemma 2 (Latest)"
      },
      {
        "id": "embeddinggemma-2:740m",
        "name": "EmbeddingGemma 2 740M"
      },
      {
        "id": "embeddinggemma-2:740m-bf16",
        "name": "EmbeddingGemma 2 740M (BF16)"
      },
      {
        "id": "embeddinggemma-2:740m-q8_0",
        "name": "EmbeddingGemma 2 740M (Q8_0)"
      },
      {
        "id": "embeddinggemma-2:570m",
        "name": "EmbeddingGemma 2 570M"
      },
      {
        "id": "embeddinggemma-2:570m-bf16-text-audio",
        "name": "EmbeddingGemma 2 570M Audio (BF16)"
      },
      {
        "id": "embeddinggemma-2:570m-q8_0-text-audio",
        "name": "EmbeddingGemma 2 570M Audio (Q8_0)"
      },
      {
        "id": "embeddinggemma-2:440m",
        "name": "EmbeddingGemma 2 440M"
      },
      {
        "id": "embeddinggemma-2:440m-bf16-text-vision",
        "name": "EmbeddingGemma 2 440M Vision (BF16)"
      },
      {
        "id": "embeddinggemma-2:440m-q8_0-text-vision",
        "name": "EmbeddingGemma 2 440M Vision (Q8_0)"
      },
      {
        "id": "embeddinggemma-2:270m",
        "name": "EmbeddingGemma 2 270M"
      },
      {
        "id": "embeddinggemma-2:270m-bf16-text",
        "name": "EmbeddingGemma 2 270M Text (BF16)"
      },
      {
        "id": "embeddinggemma-2:270m-q8_0-text",
        "name": "EmbeddingGemma 2 270M Text (Q8_0)"
      },
      {
        "id": "all-minilm",
        "name": "All-MiniLM"
      },
      {
        "id": "all-minilm:latest",
        "name": "All-MiniLM (Latest)"
      },
      {
        "id": "all-minilm:33m",
        "name": "All-MiniLM 33M (L12)"
      },
      {
        "id": "all-minilm:22m",
        "name": "All-MiniLM 22M (L6)"
      },
      {
        "id": "all-minilm:l12-v2",
        "name": "All-MiniLM L12 v2"
      },
      {
        "id": "all-minilm:l6-v2",
        "name": "All-MiniLM L6 v2"
      },
      {
        "id": "all-minilm:33m-l12-v2-fp16",
        "name": "All-MiniLM 33M L12 v2 (FP16)"
      },
      {
        "id": "all-minilm:22m-l6-v2-fp16",
        "name": "All-MiniLM 22M L6 v2 (FP16)"
      },
      {
        "id": "snowflake-arctic-embed",
        "name": "Snowflake Arctic Embed"
      },
      {
        "id": "snowflake-arctic-embed:latest",
        "name": "Snowflake Arctic Embed (Latest)"
      },
      {
        "id": "snowflake-arctic-embed:335m",
        "name": "Snowflake Arctic Embed 335M (L)"
      },
      {
        "id": "snowflake-arctic-embed:137m",
        "name": "Snowflake Arctic Embed 137M (M-Long)"
      },
      {
        "id": "snowflake-arctic-embed:110m",
        "name": "Snowflake Arctic Embed 110M (M)"
      },
      {
        "id": "snowflake-arctic-embed:33m",
        "name": "Snowflake Arctic Embed 33M (S)"
      },
      {
        "id": "snowflake-arctic-embed:22m",
        "name": "Snowflake Arctic Embed 22M (XS)"
      },
      {
        "id": "snowflake-arctic-embed:l",
        "name": "Snowflake Arctic Embed L"
      },
      {
        "id": "snowflake-arctic-embed:m",
        "name": "Snowflake Arctic Embed M"
      },
      {
        "id": "snowflake-arctic-embed:m-long",
        "name": "Snowflake Arctic Embed M-Long"
      },
      {
        "id": "snowflake-arctic-embed:s",
        "name": "Snowflake Arctic Embed S"
      },
      {
        "id": "snowflake-arctic-embed:xs",
        "name": "Snowflake Arctic Embed XS"
      },
      {
        "id": "snowflake-arctic-embed:335m-l-fp16",
        "name": "Snowflake Arctic Embed 335M L (FP16)"
      },
      {
        "id": "snowflake-arctic-embed:137m-m-long-fp16",
        "name": "Snowflake Arctic Embed 137M M-Long (FP16)"
      },
      {
        "id": "snowflake-arctic-embed:110m-m-fp16",
        "name": "Snowflake Arctic Embed 110M M (FP16)"
      },
      {
        "id": "snowflake-arctic-embed:33m-s-fp16",
        "name": "Snowflake Arctic Embed 33M S (FP16)"
      },
      {
        "id": "snowflake-arctic-embed:22m-xs-fp16",
        "name": "Snowflake Arctic Embed 22M XS (FP16)"
      },
      {
        "id": "snowflake-arctic-embed2",
        "name": "Snowflake Arctic Embed 2"
      },
      {
        "id": "snowflake-arctic-embed2:latest",
        "name": "Snowflake Arctic Embed 2 (Latest)"
      },
      {
        "id": "snowflake-arctic-embed2:568m",
        "name": "Snowflake Arctic Embed 2 568M"
      },
      {
        "id": "snowflake-arctic-embed2:568m-l-fp16",
        "name": "Snowflake Arctic Embed 2 568M L (FP16)"
      },
      {
        "id": "granite-embedding",
        "name": "Granite Embedding"
      },
      {
        "id": "granite-embedding:latest",
        "name": "Granite Embedding (Latest)"
      },
      {
        "id": "granite-embedding:278m",
        "name": "Granite Embedding 278M (Multilingual)"
      },
      {
        "id": "granite-embedding:30m",
        "name": "Granite Embedding 30M (EN)"
      },
      {
        "id": "granite-embedding:30m-en",
        "name": "Granite Embedding 30M EN"
      },
      {
        "id": "granite-embedding:278m-fp16",
        "name": "Granite Embedding 278M (FP16)"
      },
      {
        "id": "granite-embedding:30m-en-fp16",
        "name": "Granite Embedding 30M EN (FP16)"
      },
      {
        "id": "paraphrase-multilingual",
        "name": "Paraphrase Multilingual"
      },
      {
        "id": "paraphrase-multilingual:latest",
        "name": "Paraphrase Multilingual (Latest)"
      },
      {
        "id": "paraphrase-multilingual:278m",
        "name": "Paraphrase Multilingual 278M"
      },
      {
        "id": "paraphrase-multilingual:278m-mpnet-base-v2-fp16",
        "name": "Paraphrase Multilingual 278M (FP16)"
      },
      {
        "id": "laya",
        "name": "Laya"
      },
      {
        "id": "laya:latest",
        "name": "Laya (Latest)"
      },
      {
        "id": "laya:421m-english-bf16",
        "name": "Laya 421M English (BF16)"
      },
      {
        "id": "laya:322m-multilingual-bf16",
        "name": "Laya 322M Multilingual (BF16)"
      },
      {
        "id": "laya:421m-typed-decisions-bf16",
        "name": "Laya 421M Decisions (BF16)"
      }
    ]
  },
  {
    "id": "ollama-search",
    "alias": "ollama-search",
    "name": "Ollama Search",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Ollama Search Default"
      }
    ]
  },
  {
    "id": "openai",
    "alias": "openai",
    "name": "OpenAI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "gpt-5.5",
        "name": "GPT-5.5"
      },
      {
        "id": "gpt-5.4",
        "name": "GPT-5.4"
      },
      {
        "id": "gpt-5.4-mini",
        "name": "GPT-5.4 Mini"
      },
      {
        "id": "gpt-5.4-nano",
        "name": "GPT-5.4 Nano"
      },
      {
        "id": "gpt-5.2",
        "name": "GPT-5.2"
      },
      {
        "id": "gpt-5.1",
        "name": "GPT-5.1"
      },
      {
        "id": "gpt-5",
        "name": "GPT-5"
      },
      {
        "id": "gpt-5-mini",
        "name": "GPT-5 Mini"
      },
      {
        "id": "gpt-5-nano",
        "name": "GPT-5 Nano"
      },
      {
        "id": "gpt-4o",
        "name": "GPT-4o"
      },
      {
        "id": "gpt-4o-mini",
        "name": "GPT-4o Mini"
      },
      {
        "id": "gpt-4-turbo",
        "name": "GPT-4 Turbo"
      },
      {
        "id": "gpt-4.1",
        "name": "GPT-4.1"
      },
      {
        "id": "gpt-4.1-mini",
        "name": "GPT-4.1 Mini"
      },
      {
        "id": "gpt-4.1-nano",
        "name": "GPT-4.1 Nano"
      },
      {
        "id": "o3",
        "name": "O3"
      },
      {
        "id": "o3-mini",
        "name": "O3 Mini"
      },
      {
        "id": "o3-pro",
        "name": "O3 Pro"
      },
      {
        "id": "o4-mini",
        "name": "O4 Mini"
      },
      {
        "id": "o1",
        "name": "O1"
      },
      {
        "id": "o1-mini",
        "name": "O1 Mini"
      },
      {
        "id": "text-embedding-3-large",
        "name": "Text Embedding 3 Large"
      },
      {
        "id": "text-embedding-3-small",
        "name": "Text Embedding 3 Small"
      },
      {
        "id": "text-embedding-ada-002",
        "name": "Text Embedding Ada 002"
      },
      {
        "id": "tts-1",
        "name": "TTS-1"
      },
      {
        "id": "tts-1-hd",
        "name": "TTS-1 HD"
      },
      {
        "id": "gpt-4o-mini-tts",
        "name": "GPT-4o Mini TTS"
      },
      {
        "id": "whisper-1",
        "name": "Whisper 1"
      },
      {
        "id": "gpt-4o-transcribe",
        "name": "GPT-4o Transcribe"
      },
      {
        "id": "gpt-4o-mini-transcribe",
        "name": "GPT-4o Mini Transcribe"
      },
      {
        "id": "gpt-image-2.5",
        "name": "GPT Image 2.5"
      },
      {
        "id": "gpt-image-2.5-flare",
        "name": "GPT Image 2.5 Flare"
      },
      {
        "id": "gpt-image-2.5-sunburst",
        "name": "GPT Image 2.5 Sunburst"
      },
      {
        "id": "gpt-image-1",
        "name": "GPT Image 1"
      },
      {
        "id": "dall-e-3",
        "name": "DALL-E 3"
      },
      {
        "id": "dall-e-2",
        "name": "DALL-E 2"
      }
    ]
  },
  {
    "id": "codex",
    "alias": "cx",
    "name": "OpenAI Codex",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "models": [
      {
        "id": "gpt-6.1-sol",
        "name": "GPT 6.1 Sol"
      },
      {
        "id": "gpt-6.1-terra",
        "name": "GPT 6.1 Terra"
      },
      {
        "id": "gpt-6-astra",
        "name": "GPT 6.0 Astra"
      },
      {
        "id": "gpt-6-astra[1m]",
        "name": "GPT 6.0 Astra (extended context)"
      },
      {
        "id": "gpt-6-sol",
        "name": "GPT 6.0 Sol"
      },
      {
        "id": "gpt-6-sol[1m]",
        "name": "GPT 6.0 Sol (extended context)"
      },
      {
        "id": "gpt-6-luna",
        "name": "GPT 6.0 Luna"
      },
      {
        "id": "gpt-6-luna[1m]",
        "name": "GPT 6.0 Luna (extended context)"
      },
      {
        "id": "gpt-5.6-sol",
        "name": "GPT 5.6 Sol"
      },
      {
        "id": "gpt-5.6-sol[1m]",
        "name": "GPT 5.6 Sol (extended context)"
      },
      {
        "id": "gpt-5.6-sol-review",
        "name": "GPT 5.6 Sol Review"
      },
      {
        "id": "gpt-5.6-terra",
        "name": "GPT 5.6 Terra"
      },
      {
        "id": "gpt-5.6-terra[1m]",
        "name": "GPT 5.6 Terra (extended context)"
      },
      {
        "id": "gpt-5.6-terra-review",
        "name": "GPT 5.6 Terra Review"
      },
      {
        "id": "gpt-5.6-luna",
        "name": "GPT 5.6 Luna"
      },
      {
        "id": "gpt-5.6-luna[1m]",
        "name": "GPT 5.6 Luna (extended context)"
      },
      {
        "id": "gpt-5.6-luna-review",
        "name": "GPT 5.6 Luna Review"
      },
      {
        "id": "gpt-daybreak-blue-latest",
        "name": "GPT Daybreak Blue"
      },
      {
        "id": "gpt-reserve",
        "name": "GPT Reserve"
      },
      {
        "id": "codex-auto-review",
        "name": "Codex Auto Review"
      },
      {
        "id": "gpt-image-2.5",
        "name": "GPT Image 2.5"
      },
      {
        "id": "gpt-image-2.5-flare",
        "name": "GPT Image 2.5 Flare"
      },
      {
        "id": "gpt-image-2.5-sunburst",
        "name": "GPT Image 2.5 Sunburst"
      },
      {
        "id": "gpt-image-2",
        "name": "GPT Image 2"
      },
      {
        "id": "gpt-image-1.5",
        "name": "GPT Image 1.5"
      },
      {
        "id": "gpt-6-sol-image",
        "name": "GPT 6.0 Sol Image"
      },
      {
        "id": "transcribe",
        "name": "Codex Transcription"
      }
    ]
  },
  {
    "id": "opencode",
    "alias": "oc",
    "name": "OpenCode Free",
    "category": "free",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://opencode.ai/zen/v1",
    "models": [
      {
        "id": "muse-spark-1.2-contributor-free",
        "name": "Muse Spark 1.2 Contributor Free"
      },
      {
        "id": "muse-spark-1.3-contributor-free",
        "name": "Muse Spark 1.3 Contributor Free"
      },
      {
        "id": "union-alpha",
        "name": "Union Alpha Free"
      },
      {
        "id": "jev-1.13-free",
        "name": "Jev 1.13 Free"
      }
    ]
  },
  {
    "id": "opencode-go",
    "alias": "ocg",
    "name": "OpenCode Go",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "models": [
      {
        "id": "deepseek-flash",
        "name": "DeepSeek Flash"
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM 5.3 Flash (Vision)"
      },
      {
        "id": "glm-5.3",
        "name": "GLM 5.3"
      },
      {
        "id": "glm-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "glm-5.1",
        "name": "GLM 5.1"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3"
      },
      {
        "id": "kimi-k3.1-pro",
        "name": "Kimi K3.1 Pro"
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "deepseek-v4-flash-vision-exp",
        "name": "DeepSeek V4 Flash Vision (Exp)"
      },
      {
        "id": "deepseek-v4.1-flash",
        "name": "DeepSeek V4.1 Flash"
      },
      {
        "id": "longcat-2.0",
        "name": "LongCat 2.0"
      },
      {
        "id": "mimo-v2.6-flash",
        "name": "MiMo V2.6 Flash"
      },
      {
        "id": "mimo-v2.6-pro",
        "name": "MiMo V2.6 Pro"
      },
      {
        "id": "mimo-v2.5",
        "name": "MiMo V2.5"
      },
      {
        "id": "mimo-v2.5-pro",
        "name": "MiMo V2.5 Pro"
      },
      {
        "id": "mimo-v2-pro",
        "name": "MiMo V2 Pro"
      },
      {
        "id": "mimo-v2-omni",
        "name": "MiMo V2 Omni"
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax M3"
      },
      {
        "id": "minimax-m2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "minimax-m2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "space-bunny-free",
        "name": "Space Bunny Free"
      },
      {
        "id": "qwen3.8-max",
        "name": "Qwen 3.8 Max"
      },
      {
        "id": "qwen3.8-flash",
        "name": "Qwen 3.8 Flash"
      },
      {
        "id": "qwen3.7-max",
        "name": "Qwen 3.7 Max"
      },
      {
        "id": "qwen3.7-plus",
        "name": "Qwen 3.7 Plus"
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen 3.6 Plus"
      },
      {
        "id": "qwen3.5-plus",
        "name": "Qwen 3.5 Plus"
      },
      {
        "id": "hy4-preview",
        "name": "Hy4 Preview"
      },
      {
        "id": "hy3",
        "name": "Hy3"
      },
      {
        "id": "hy3-preview",
        "name": "Hy3 Preview"
      },
      {
        "id": "omen-alpha",
        "name": "Omen Alpha"
      },
      {
        "id": "grok-4.7",
        "name": "Grok 4.7"
      },
      {
        "id": "grok-4.6",
        "name": "Grok 4.6"
      },
      {
        "id": "grok-4.5",
        "name": "Grok 4.5"
      },
      {
        "id": "gpt-5.6-luna",
        "name": "GPT 5.6 Luna"
      },
      {
        "id": "gpt-6-luna",
        "name": "GPT 6 Luna"
      },
      {
        "id": "muse-spark-1.2-contributor",
        "name": "Muse Spark 1.2 Contributor"
      },
      {
        "id": "muse-spark-1.3-contributor",
        "name": "Muse Spark 1.3 Contributor"
      },
      {
        "id": "claude-haiku-5-5",
        "name": "Claude Haiku 5.5"
      }
    ]
  },
  {
    "id": "opencode-zen",
    "alias": "ocz",
    "name": "OpenCode Zen",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://opencode.ai/zen/v1",
    "models": [
      {
        "id": "claude-fable-5",
        "name": "Claude Fable 5"
      },
      {
        "id": "claude-fable-5-1",
        "name": "Claude Fable 5.1"
      },
      {
        "id": "claude-opus-5",
        "name": "Claude Opus 5"
      },
      {
        "id": "claude-opus-4-8",
        "name": "Claude Opus 4.8"
      },
      {
        "id": "claude-opus-4-7",
        "name": "Claude Opus 4.7"
      },
      {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6"
      },
      {
        "id": "claude-opus-4-5",
        "name": "Claude Opus 4.5"
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5"
      },
      {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "claude-sonnet-4-5",
        "name": "Claude Sonnet 4.5"
      },
      {
        "id": "claude-sonnet-4",
        "name": "Claude Sonnet 4"
      },
      {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5"
      },
      {
        "id": "gemini-3.6-flash",
        "name": "Gemini 3.6 Flash"
      },
      {
        "id": "gemini-3.8-flash",
        "name": "Gemini 3.8 Flash"
      },
      {
        "id": "gemini-3.7-flash",
        "name": "Gemini 3.7 Flash"
      },
      {
        "id": "gemini-3.5-flash-lite",
        "name": "Gemini 3.5 Flash Lite"
      },
      {
        "id": "gemini-3.5-flash",
        "name": "Gemini 3.5 Flash"
      },
      {
        "id": "gemini-3.1-pro",
        "name": "Gemini 3.1 Pro"
      },
      {
        "id": "gemini-3-flash",
        "name": "Gemini 3 Flash"
      },
      {
        "id": "gpt-6-astra",
        "name": "GPT 6 Astra"
      },
      {
        "id": "gpt-5.6-sol",
        "name": "GPT 5.6 Sol"
      },
      {
        "id": "gpt-5.6-terra",
        "name": "GPT 5.6 Terra"
      },
      {
        "id": "gpt-5.6-luna",
        "name": "GPT 5.6 Luna"
      },
      {
        "id": "gpt-5.5",
        "name": "GPT 5.5"
      },
      {
        "id": "gpt-5.5-pro",
        "name": "GPT 5.5 Pro"
      },
      {
        "id": "gpt-5.4",
        "name": "GPT 5.4"
      },
      {
        "id": "gpt-5.4-pro",
        "name": "GPT 5.4 Pro"
      },
      {
        "id": "gpt-5.4-mini",
        "name": "GPT 5.4 Mini"
      },
      {
        "id": "gpt-5.4-nano",
        "name": "GPT 5.4 Nano"
      },
      {
        "id": "gpt-5.3-codex-spark",
        "name": "GPT 5.3 Codex Spark"
      },
      {
        "id": "gpt-5.3-codex",
        "name": "GPT 5.3 Codex"
      },
      {
        "id": "gpt-5.2",
        "name": "GPT 5.2"
      },
      {
        "id": "gpt-5.2-codex",
        "name": "GPT 5.2 Codex"
      },
      {
        "id": "gpt-5.1",
        "name": "GPT 5.1"
      },
      {
        "id": "gpt-5.1-codex-max",
        "name": "GPT 5.1 Codex Max"
      },
      {
        "id": "gpt-5.1-codex",
        "name": "GPT 5.1 Codex"
      },
      {
        "id": "gpt-5.1-codex-mini",
        "name": "GPT 5.1 Codex Mini"
      },
      {
        "id": "gpt-5",
        "name": "GPT 5"
      },
      {
        "id": "gpt-5-codex",
        "name": "GPT 5 Codex"
      },
      {
        "id": "gpt-5-nano",
        "name": "GPT 5 Nano"
      },
      {
        "id": "grok-build-0.1",
        "name": "Grok Build 0.1"
      },
      {
        "id": "grok-4.6",
        "name": "Grok 4.6"
      },
      {
        "id": "grok-4.5",
        "name": "Grok 4.5"
      },
      {
        "id": "muse-spark-1.3",
        "name": "Muse Spark 1.3"
      },
      {
        "id": "muse-spark-1.2",
        "name": "Muse Spark 1.2"
      },
      {
        "id": "qwen3.6-plus",
        "name": "Qwen 3.6 Plus"
      },
      {
        "id": "qwen3.5-plus",
        "name": "Qwen 3.5 Plus"
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "deepseek-v4-flash-vision-exp",
        "name": "DeepSeek V4 Flash Vision Exp"
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM 5.3 Flash (Vision)"
      },
      {
        "id": "glm-5.3",
        "name": "GLM 5.3"
      },
      {
        "id": "glm-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "glm-5.1",
        "name": "GLM 5.1"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax M3"
      },
      {
        "id": "minimax-m2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "minimax-m2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3"
      },
      {
        "id": "kimi-k2.7-code",
        "name": "Kimi K2.7 Code"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "big-pickle",
        "name": "Big Pickle"
      },
      {
        "id": "union-alpha",
        "name": "Union Alpha"
      },
      {
        "id": "deepseek-v4-flash-free",
        "name": "DeepSeek V4 Flash Free"
      },
      {
        "id": "mimo-v2.6-flash-free",
        "name": "MiMo V2.6 Flash Free"
      },
      {
        "id": "mimo-v2.5-free",
        "name": "MiMo V2.5 Free"
      },
      {
        "id": "ling-3.0-flash-fin-free",
        "name": "Ling 3.0 Flash Fin Free"
      },
      {
        "id": "nemotron-3-ultra-free",
        "name": "Nemotron 3 Ultra Free"
      },
      {
        "id": "nemotron-3.5-lightning-free",
        "name": "Nemotron 3.5 Lightning Free"
      },
      {
        "id": "muse-spark-1.3-contributor-free",
        "name": "Muse Spark 1.3 Contributor Free"
      },
      {
        "id": "muse-spark-1.2-contributor-free",
        "name": "Muse Spark 1.2 Contributor Free"
      },
      {
        "id": "jev-1.13",
        "name": "Jev 1.13"
      },
      {
        "id": "jev-1.13-free",
        "name": "Jev 1.13 Free"
      }
    ]
  },
  {
    "id": "openrouter",
    "alias": "openrouter",
    "name": "OpenRouter",
    "category": "freeTier",
    "authMethods": [
      "api_key",
      "oauth_pkce"
    ],
    "baseUrl": "https://openrouter.ai/api/v1",
    "models": [
      {
        "id": "openrouter/auto",
        "name": "OpenRouter Auto"
      },
      {
        "id": "anthropic/claude-sonnet-4",
        "name": "Claude Sonnet 4"
      },
      {
        "id": "openai/gpt-4o",
        "name": "GPT-4o"
      },
      {
        "id": "openai/gpt-4o-mini",
        "name": "GPT-4o Mini"
      },
      {
        "id": "google/gemini-2.5-pro",
        "name": "Gemini 2.5 Pro"
      },
      {
        "id": "google/gemini-2.5-flash",
        "name": "Gemini 2.5 Flash"
      },
      {
        "id": "deepseek/deepseek-r1:free",
        "name": "DeepSeek R1 (Free)"
      },
      {
        "id": "meta-llama/llama-3.3-70b-instruct:free",
        "name": "Llama 3.3 70B Instruct (Free)"
      },
      {
        "id": "openai/text-embedding-3-large",
        "name": "OpenAI Text Embedding 3 Large"
      },
      {
        "id": "openai/text-embedding-3-small",
        "name": "OpenAI Text Embedding 3 Small"
      },
      {
        "id": "openai/text-embedding-ada-002",
        "name": "OpenAI Text Embedding Ada 002"
      },
      {
        "id": "qwen/qwen3-embedding-8b",
        "name": "Qwen3 Embedding 8B"
      },
      {
        "id": "perplexity/pplx-embed-v1-4b",
        "name": "Perplexity Embed V1 4B"
      },
      {
        "id": "perplexity/pplx-embed-v1-0.6b",
        "name": "Perplexity Embed V1 0.6B"
      },
      {
        "id": "nvidia/llama-nemotron-embed-vl-1b-v2:free",
        "name": "NVIDIA Nemotron Embed VL 1B V2 (Free)"
      },
      {
        "id": "openai/gpt-4o-mini-tts",
        "name": "GPT-4o Mini TTS"
      },
      {
        "id": "openai/tts-1-hd",
        "name": "TTS-1 HD"
      },
      {
        "id": "openai/tts-1",
        "name": "TTS-1"
      },
      {
        "id": "openai/dall-e-3",
        "name": "DALL-E 3 (via OpenRouter)"
      },
      {
        "id": "openai/gpt-image-1",
        "name": "GPT Image 1 (via OpenRouter)"
      },
      {
        "id": "google/imagen-3.0-generate-002",
        "name": "Imagen 3 (via OpenRouter)"
      },
      {
        "id": "black-forest-labs/FLUX.1-schnell",
        "name": "FLUX.1 Schnell (via OpenRouter)"
      },
      {
        "id": "google/veo-3.1",
        "name": "Veo 3.1 (via OpenRouter)"
      },
      {
        "id": "openai/sora-2-pro",
        "name": "Sora 2 Pro (via OpenRouter)"
      },
      {
        "id": "bytedance/seedance-2.0",
        "name": "Seedance 2.0 (via OpenRouter)"
      },
      {
        "id": "typesafe/jev-1.13",
        "name": "Jev 1.13"
      }
    ]
  },
  {
    "id": "perplexity",
    "alias": "pplx",
    "name": "Perplexity",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.perplexity.ai",
    "models": [
      {
        "id": "sonar-pro",
        "name": "Sonar Pro"
      },
      {
        "id": "sonar",
        "name": "Sonar"
      }
    ]
  },
  {
    "id": "perplexity-agent",
    "alias": "pa",
    "name": "Perplexity Agent",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.perplexity.ai/v1",
    "models": [
      {
        "id": "perplexity/sonar",
        "name": "Perplexity Sonar"
      },
      {
        "id": "openai/gpt-5.5",
        "name": "GPT-5.5"
      },
      {
        "id": "openai/gpt-5.4",
        "name": "GPT-5.4"
      },
      {
        "id": "openai/gpt-5.4-mini",
        "name": "GPT-5.4 Mini"
      },
      {
        "id": "anthropic/claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "anthropic/claude-opus-4-8",
        "name": "Claude Opus 4.8"
      },
      {
        "id": "google/gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro"
      },
      {
        "id": "xai/grok-4.20-reasoning",
        "name": "Grok 4.20 Reasoning"
      },
      {
        "id": "perplexity/glm-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "perplexity/kimi-k2.7-code",
        "name": "Kimi K2.7 Code"
      },
      {
        "id": "nvidia/nemotron-3-super-120b-a12b",
        "name": "Nemotron 3 Super 120B"
      }
    ]
  },
  {
    "id": "perplexity-web",
    "alias": "pw",
    "name": "Perplexity Web (Pro/Max)",
    "category": "webCookie",
    "authMethods": [
      "cookie",
      "api_key"
    ],
    "baseUrl": "https://www.perplexity.ai/rest/sse/perplexity_ask",
    "models": [
      {
        "id": "pplx-auto",
        "name": "Perplexity Auto (Free)"
      },
      {
        "id": "pplx-sonar",
        "name": "Perplexity Sonar"
      },
      {
        "id": "pplx-gpt",
        "name": "GPT-5.4 (via Perplexity)"
      },
      {
        "id": "pplx-gemini",
        "name": "Gemini 3.1 Pro (via Perplexity)"
      },
      {
        "id": "pplx-sonnet",
        "name": "Claude Sonnet 4.6 (via Perplexity)"
      },
      {
        "id": "pplx-opus",
        "name": "Claude Opus 4.6 (via Perplexity)"
      },
      {
        "id": "pplx-nemotron",
        "name": "Nemotron 3 Super (via Perplexity)"
      }
    ]
  },
  {
    "id": "playht",
    "alias": "playht",
    "name": "PlayHT",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "PlayHT Default"
      }
    ]
  },
  {
    "id": "poolside",
    "alias": "ps",
    "name": "Poolside",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://inference.poolside.ai/v1",
    "models": [
      {
        "id": "poolside/laguna-s-2.1",
        "name": "Laguna S 2.1"
      },
      {
        "id": "poolside/laguna-xs-2.1",
        "name": "Laguna XS 2.1"
      }
    ]
  },
  {
    "id": "qoder",
    "alias": "qd",
    "name": "Qoder",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
    "models": [
      {
        "id": "ultimate",
        "name": "Ultimate"
      },
      {
        "id": "auto",
        "name": "Auto"
      },
      {
        "id": "performance",
        "name": "Performance"
      },
      {
        "id": "efficient",
        "name": "Efficient"
      },
      {
        "id": "lite",
        "name": "Lite"
      },
      {
        "id": "qmodel_38max",
        "name": "Qwen3.8-Max"
      },
      {
        "id": "qmodel_latest",
        "name": "Qwen3.7-Max"
      },
      {
        "id": "qmodel",
        "name": "Qwen3.7-Plus"
      },
      {
        "id": "qfmodel",
        "name": "Qwen3.8-Flash"
      },
      {
        "id": "kmodel_latest",
        "name": "Kimi-K3"
      },
      {
        "id": "kmodel",
        "name": "Kimi-K2.7-Code"
      },
      {
        "id": "gmodel",
        "name": "GLM-5.3"
      },
      {
        "id": "gfmodel",
        "name": "GLM-5.3-Flash"
      },
      {
        "id": "dmodel",
        "name": "DeepSeek-V4-Pro"
      },
      {
        "id": "dfmodel",
        "name": "DeepSeek-V4-Flash"
      },
      {
        "id": "mmodel",
        "name": "MiniMax-M3"
      },
      {
        "id": "smodel",
        "name": "Sonus"
      },
      {
        "id": "cmodel",
        "name": "Cantus"
      }
    ]
  },
  {
    "id": "qoder-cn",
    "alias": "qdcn",
    "name": "Qoder CN",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
    "models": [
      {
        "id": "ultimate",
        "name": "Ultimate"
      },
      {
        "id": "auto",
        "name": "Auto"
      },
      {
        "id": "performance",
        "name": "Performance"
      },
      {
        "id": "efficient",
        "name": "Efficient"
      },
      {
        "id": "lite",
        "name": "Lite"
      },
      {
        "id": "qmodel_38max",
        "name": "Qwen3.8-Max"
      },
      {
        "id": "qmodel_latest",
        "name": "Qwen3.7-Max"
      },
      {
        "id": "qmodel",
        "name": "Qwen3.7-Plus"
      },
      {
        "id": "qfmodel",
        "name": "Qwen3.8-Flash"
      },
      {
        "id": "kmodel_latest",
        "name": "Kimi-K3"
      },
      {
        "id": "kmodel",
        "name": "Kimi-K2.7-Code"
      },
      {
        "id": "gmodel",
        "name": "GLM-5.3"
      },
      {
        "id": "gfmodel",
        "name": "GLM-5.3-Flash"
      },
      {
        "id": "dmodel",
        "name": "DeepSeek-V4-Pro"
      },
      {
        "id": "dfmodel",
        "name": "DeepSeek-V4-Flash"
      },
      {
        "id": "mmodel",
        "name": "MiniMax-M3"
      }
    ]
  },
  {
    "id": "qwen",
    "alias": "qw",
    "name": "Qwen Code",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://portal.qwen.ai/v1",
    "models": [
      {
        "id": "qwen3-coder-plus",
        "name": "Qwen3 Coder Plus"
      },
      {
        "id": "qwen3-coder-flash",
        "name": "Qwen3 Coder Flash"
      }
    ]
  },
  {
    "id": "recraft",
    "alias": "recraft",
    "name": "Recraft",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "recraftv3",
        "name": "Recraft V3"
      },
      {
        "id": "recraftv2",
        "name": "Recraft V2"
      }
    ]
  },
  {
    "id": "runcrate",
    "alias": "rc",
    "name": "Runcrate",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.runcrate.ai/v1",
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash",
        "name": "DeepSeek V4.1 Flash"
      },
      {
        "id": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
        "name": "DeepSeek V4.1 Flash 1017"
      },
      {
        "id": "zai-org/GLM-5.3",
        "name": "GLM 5.3"
      },
      {
        "id": "zai-org/GLM-5.3-Flash",
        "name": "GLM 5.3 Flash"
      },
      {
        "id": "Qwen/Qwen3.8-Flash",
        "name": "Qwen3.8 Flash"
      },
      {
        "id": "openai/gpt-oss-120b",
        "name": "gpt-oss 120B"
      }
    ]
  },
  {
    "id": "runwayml",
    "alias": "runway",
    "name": "Runway ML",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "gen4_image",
        "name": "Gen-4 Image"
      },
      {
        "id": "gen4_image_turbo",
        "name": "Gen-4 Image Turbo"
      },
      {
        "id": "gen4_turbo",
        "name": "Gen-4 Turbo"
      },
      {
        "id": "gen3a_turbo",
        "name": "Gen-3 Alpha Turbo"
      }
    ]
  },
  {
    "id": "sambanova",
    "alias": "samba",
    "name": "SambaNova",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.sambanova.ai/v1",
    "models": [
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax M2.7"
      }
    ]
  },
  {
    "id": "sdwebui",
    "alias": "sdwebui",
    "name": "SD WebUI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "stable-diffusion-v1-5",
        "name": "Stable Diffusion v1.5"
      },
      {
        "id": "sdxl-base-1.0",
        "name": "SDXL Base 1.0"
      }
    ]
  },
  {
    "id": "searchapi",
    "alias": "searchapi",
    "name": "SearchAPI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "SearchAPI Default"
      }
    ]
  },
  {
    "id": "searxng",
    "alias": "searxng",
    "name": "SearXNG",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "SearXNG Default"
      }
    ]
  },
  {
    "id": "selfhosted-embedding",
    "alias": "selfhosted-embedding",
    "name": "Self-hosted Embedding",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "embedding",
        "name": "Self-hosted embedding model"
      }
    ]
  },
  {
    "id": "selfhosted-stt",
    "alias": "selfhosted-stt",
    "name": "Self-hosted STT",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "whisper-1",
        "name": "Whisper (self-hosted)"
      }
    ]
  },
  {
    "id": "selfhosted-tts",
    "alias": "selfhosted-tts",
    "name": "Self-hosted TTS",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "kokoro",
        "name": "Kokoro (self-hosted)"
      }
    ]
  },
  {
    "id": "sensenova",
    "alias": "sensenova",
    "name": "SenseNova",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://token.sensenova.cn/v1",
    "models": [
      {
        "id": "sensenova-6.8-flash-lite",
        "name": "SenseNova 6.8 Flash Lite"
      },
      {
        "id": "sensenova-u1.5-lite",
        "name": "SenseNova U1.5 Lite"
      },
      {
        "id": "sensenova-u1.5-fast",
        "name": "SenseNova U1.5 Fast"
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "deepseek-flash",
        "name": "DeepSeek V4.1 Flash"
      },
      {
        "id": "glm-5.2",
        "name": "GLM-5.2"
      },
      {
        "id": "kimi-k3",
        "name": "Kimi K3"
      }
    ]
  },
  {
    "id": "serper",
    "alias": "serper",
    "name": "Serper",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Serper Default"
      }
    ]
  },
  {
    "id": "siliconflow",
    "alias": "siliconflow",
    "name": "SiliconFlow",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.siliconflow.com/v1",
    "models": [
      {
        "id": "deepseek-ai/DeepSeek-V4-Pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "name": "DeepSeek V4 Flash"
      },
      {
        "id": "deepseek-ai/DeepSeek-V3.2",
        "name": "DeepSeek V3.2"
      },
      {
        "id": "deepseek-ai/DeepSeek-V3.2-Exp",
        "name": "DeepSeek V3.2 Exp"
      },
      {
        "id": "deepseek-ai/DeepSeek-V3.1",
        "name": "DeepSeek V3.1"
      },
      {
        "id": "deepseek-ai/DeepSeek-V3.1-Terminus",
        "name": "DeepSeek V3.1 Terminus"
      },
      {
        "id": "deepseek-ai/DeepSeek-R1",
        "name": "DeepSeek R1"
      },
      {
        "id": "Qwen/Qwen3.5-397B-A17B",
        "name": "Qwen 3.5 397B A17B"
      },
      {
        "id": "Qwen/Qwen3.5-122B-A10B",
        "name": "Qwen 3.5 122B A10B"
      },
      {
        "id": "zai-org/GLM-5.1",
        "name": "GLM 5.1"
      },
      {
        "id": "zai-org/GLM-5",
        "name": "GLM 5"
      },
      {
        "id": "moonshotai/Kimi-K2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "moonshotai/Kimi-K2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "openai/gpt-oss-120b",
        "name": "GPT OSS 120B"
      },
      {
        "id": "MiniMaxAI/MiniMax-M2.5",
        "name": "MiniMax M2.5"
      },
      {
        "id": "inclusionAI/Ling-flash-2.0",
        "name": "Ling Flash 2.0"
      }
    ]
  },
  {
    "id": "stability-ai",
    "alias": "stability",
    "name": "Stability AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "stable-image-ultra",
        "name": "Stable Image Ultra"
      },
      {
        "id": "stable-image-core",
        "name": "Stable Image Core"
      },
      {
        "id": "sd3.5-large",
        "name": "Stable Diffusion 3.5 Large"
      },
      {
        "id": "sd3.5-large-turbo",
        "name": "Stable Diffusion 3.5 Large Turbo"
      },
      {
        "id": "sd3.5-medium",
        "name": "Stable Diffusion 3.5 Medium"
      }
    ]
  },
  {
    "id": "tavily",
    "alias": "tavily",
    "name": "Tavily",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Tavily Default"
      }
    ]
  },
  {
    "id": "tencent",
    "alias": "hunyuan",
    "name": "Tencent Hunyuan",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.hunyuan.cloud.tencent.com/v1",
    "models": [
      {
        "id": "hunyuan-turbos-latest",
        "name": "Hunyuan TurboS Latest"
      },
      {
        "id": "hunyuan-t1-latest",
        "name": "Hunyuan T1 Latest"
      }
    ]
  },
  {
    "id": "tinyfish",
    "alias": "tinyfish",
    "name": "TinyFish",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "TinyFish Default"
      }
    ]
  },
  {
    "id": "together",
    "alias": "together",
    "name": "Together AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.together.xyz/v1",
    "models": [
      {
        "id": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "name": "Llama 3.3 70B Turbo"
      },
      {
        "id": "deepseek-ai/DeepSeek-R1",
        "name": "DeepSeek R1"
      },
      {
        "id": "Qwen/Qwen3-235B-A22B",
        "name": "Qwen3 235B"
      },
      {
        "id": "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        "name": "Llama 4 Maverick"
      },
      {
        "id": "BAAI/bge-large-en-v1.5",
        "name": "BGE Large EN v1.5"
      },
      {
        "id": "togethercomputer/m2-bert-80M-8k-retrieval",
        "name": "M2 BERT 80M 8K"
      }
    ]
  },
  {
    "id": "tokenharbor",
    "alias": "tokenharbor",
    "name": "Token Harbor",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://tokenharbor.ai/v1",
    "models": [
      {
        "id": "claude-opus-5.5",
        "name": "Claude Opus 5.5"
      },
      {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5"
      },
      {
        "id": "gpt-6-astra",
        "name": "GPT-6 Astra"
      },
      {
        "id": "gpt-6-sol",
        "name": "GPT-6 Sol"
      },
      {
        "id": "deepseek-v4.1-flash:free",
        "name": "DeepSeek V4.1 Flash (Free)"
      },
      {
        "id": "grok-4.7",
        "name": "Grok 4.7"
      }
    ]
  },
  {
    "id": "tokenrouter",
    "alias": "tokenrouter",
    "name": "TokenRouter",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.tokenrouter.com/v1",
    "models": [
      {
        "id": "anthropic/claude-haiku-4.5",
        "name": "Claude Haiku 4.5"
      },
      {
        "id": "anthropic/claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "anthropic/claude-opus-4.8",
        "name": "Claude Opus 4.8"
      },
      {
        "id": "anthropic/claude-opus-4.8-fast",
        "name": "Claude Opus 4.8 Fast"
      },
      {
        "id": "openai/gpt-5.4",
        "name": "Gpt 5.4"
      },
      {
        "id": "openai/gpt-5.4-mini",
        "name": "Gpt 5.4 Mini"
      },
      {
        "id": "openai/gpt-5.4-pro",
        "name": "Gpt 5.4 Pro"
      },
      {
        "id": "openai/gpt-5.5",
        "name": "Gpt 5.5"
      },
      {
        "id": "openai/gpt-5.6-sol",
        "name": "Gpt 5.6 Sol"
      },
      {
        "id": "google/gemini-3.5-flash",
        "name": "Gemini 3.5 Flash"
      },
      {
        "id": "google/gemini-3.6-flash",
        "name": "Gemini 3.6 Flash"
      },
      {
        "id": "deepseek/deepseek-v4-flash",
        "name": "Deepseek V4 Flash"
      },
      {
        "id": "deepseek/deepseek-v4-pro",
        "name": "Deepseek V4 Pro"
      },
      {
        "id": "qwen/qwen3-coder-next",
        "name": "Qwen3 Coder Next"
      },
      {
        "id": "qwen/qwen3.7-max",
        "name": "Qwen3.7 Max"
      },
      {
        "id": "qwen/qwen3.8-max",
        "name": "Qwen3.8 Max"
      },
      {
        "id": "moonshotai/kimi-k2.7-code",
        "name": "Kimi K2.7 Code"
      },
      {
        "id": "moonshotai/kimi-k3-free",
        "name": "Kimi K3 Free"
      },
      {
        "id": "z-ai/glm-5.3-free",
        "name": "Glm 5.3 Free"
      },
      {
        "id": "z-ai/glm-5.2",
        "name": "Glm 5.2"
      },
      {
        "id": "z-ai/glm-5-turbo",
        "name": "Glm 5 Turbo"
      },
      {
        "id": "x-ai/grok-4.5",
        "name": "Grok 4.5"
      }
    ]
  },
  {
    "id": "topaz",
    "alias": "topaz",
    "name": "Topaz",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Topaz Default"
      }
    ]
  },
  {
    "id": "tortoise",
    "alias": "tortoise",
    "name": "Tortoise TTS",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Tortoise TTS Default"
      }
    ]
  },
  {
    "id": "trae",
    "alias": "tr",
    "name": "Trae",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://core-normal.trae.ai/api/remote/v1",
    "models": [
      {
        "id": "auto",
        "name": "Auto (Server Picks)"
      },
      {
        "id": "work",
        "name": "Work (Fast)"
      },
      {
        "id": "gemini-3.1-pro",
        "name": "Gemini 3.1 Pro"
      },
      {
        "id": "gemini-3-flash-solo",
        "name": "Gemini 3 Flash"
      },
      {
        "id": "minimax-m3",
        "name": "MiniMax M3"
      },
      {
        "id": "minimax-m2.7",
        "name": "MiniMax M2.7"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "gpt-5.4",
        "name": "GPT 5.4"
      },
      {
        "id": "gpt-5.2",
        "name": "GPT 5.2"
      }
    ]
  },
  {
    "id": "uc-web",
    "alias": "uc",
    "name": "UC Web",
    "category": "webCookie",
    "authMethods": [
      "cookie",
      "api_key"
    ],
    "baseUrl": "https://internal.chatuncensored.ai",
    "models": [
      {
        "id": "seedream-v4.5",
        "name": "Seedream v4.5 (UC)"
      },
      {
        "id": "seedream-v5",
        "name": "Seedream v5 (UC)"
      },
      {
        "id": "seedream-v5-flash",
        "name": "Seedream v5 Flash (UC)"
      },
      {
        "id": "nano-banana-pro-ultra",
        "name": "Nano Banana Pro Ultra (UC)"
      },
      {
        "id": "nano-banana-pro",
        "name": "Nano Banana Pro (UC)"
      },
      {
        "id": "nano-banana",
        "name": "Nano Banana (UC)"
      },
      {
        "id": "nano-banana-2",
        "name": "Nano Banana 2 (UC)"
      },
      {
        "id": "gpt-image",
        "name": "GPT Image 1.5 (UC)"
      },
      {
        "id": "gpt-image-2",
        "name": "GPT Image 2 (UC)"
      },
      {
        "id": "gpt-image-2.5-flare",
        "name": "GPT Image 2.5 Flare (UC)"
      },
      {
        "id": "gpt-image-2.5-sunburst",
        "name": "GPT Image 2.5 Sunburst (UC)"
      },
      {
        "id": "wan-2.6-image",
        "name": "Wan 2.6 Image (UC)"
      },
      {
        "id": "wan-2.7-text-to-image",
        "name": "Wan 2.7 (UC)"
      },
      {
        "id": "wan-2.7-text-to-image-pro",
        "name": "Wan 2.7 Pro (UC)"
      },
      {
        "id": "prefect-pony-xl",
        "name": "Prefect Pony XL (UC)"
      },
      {
        "id": "1.0",
        "name": "Flux.1 (UC)"
      },
      {
        "id": "1.1",
        "name": "Flux.1.1 (UC)"
      },
      {
        "id": "2.0",
        "name": "Flux.2 (UC)"
      },
      {
        "id": "flux-2-max",
        "name": "Flux 2 Max (UC)"
      },
      {
        "id": "SDXL",
        "name": "SDXL Uncensored (UC)"
      },
      {
        "id": "realism",
        "name": "Realism (UC)"
      },
      {
        "id": "realism-2",
        "name": "Realism 2 (UC)"
      },
      {
        "id": "z-image-turbo",
        "name": "Z-Image Turbo (UC)"
      },
      {
        "id": "default",
        "name": "Video Standard (UC)"
      },
      {
        "id": "turbo",
        "name": "Video Turbo (UC)"
      },
      {
        "id": "wan-2.2-uncensored",
        "name": "Wan Ultra Uncensored (UC)"
      },
      {
        "id": "wan-2.2-uncensored-v2",
        "name": "Wan Ultra Uncensored v2 (UC)"
      },
      {
        "id": "wan-2.6",
        "name": "Wan 2.6 Video (UC)"
      },
      {
        "id": "wan-2.6-ultra",
        "name": "Wan 2.6 Ultra Uncensored (UC)"
      },
      {
        "id": "wan-2.7",
        "name": "Wan 2.7 Video (UC)"
      },
      {
        "id": "wan-2.7-pro",
        "name": "Wan 2.7 Pro Video (UC)"
      },
      {
        "id": "wan-2.7-uncensored",
        "name": "Wan 2.7 Uncensored (UC)"
      },
      {
        "id": "wan-2.7-uncensored-v2",
        "name": "Wan 2.7 Uncensored v2 (UC)"
      },
      {
        "id": "wan-3.0",
        "name": "Wan 3.0 (UC)"
      },
      {
        "id": "wan-3.0-uncensored",
        "name": "Wan 3.0 Uncensored (UC)"
      },
      {
        "id": "wan-3.0-uncensored-pro",
        "name": "Wan 3.0 Uncensored Pro (UC)"
      },
      {
        "id": "sora-2",
        "name": "Sora 2 (UC)"
      },
      {
        "id": "sora-2-pro",
        "name": "Sora 2 Pro (UC)"
      },
      {
        "id": "grok-imagine-video",
        "name": "Grok Imagine Video (UC)"
      },
      {
        "id": "bytedance-seedance-2.0",
        "name": "Seedance 2.0 (UC)"
      },
      {
        "id": "seedance-2.0-fast",
        "name": "Seedance 2.0 Fast (UC)"
      },
      {
        "id": "seedance-2.0-uncensored",
        "name": "Seedance 2.0 Uncensored (UC)"
      },
      {
        "id": "seedance-2.0-fast-uncensored",
        "name": "Seedance 2.0 Fast Uncensored (UC)"
      },
      {
        "id": "seedance-2.0-mini-uncensored",
        "name": "Seedance 2.0 Mini Uncensored (UC)"
      },
      {
        "id": "seedance-2.0-mini-turbo",
        "name": "Seedance 2.0 Mini Turbo Uncensored (UC)"
      },
      {
        "id": "seedance-v1.5-pro-uncensored",
        "name": "Seedance v1.5 Pro Uncensored (UC)"
      },
      {
        "id": "seedance-2.5-uncensored",
        "name": "Seedance 2.5 Uncensored (UC)"
      },
      {
        "id": "seedance-2.5",
        "name": "Seedance 2.5 (UC)"
      },
      {
        "id": "vidu-q3-uncensored",
        "name": "Vidu Q3 Uncensored (UC)"
      },
      {
        "id": "av-gen-v2",
        "name": "AV-Gen v2 with audio (UC)"
      },
      {
        "id": "cosmos-predict",
        "name": "Cosmos Predict 2.5 (UC)"
      },
      {
        "id": "minimax-h3",
        "name": "MiniMax H3 (UC)"
      },
      {
        "id": "happyhorse-1.0",
        "name": "Happy Horse 1.0 (UC)"
      }
    ]
  },
  {
    "id": "v1m",
    "alias": "v1m",
    "name": "v1m (System One)",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "rev-latest",
        "name": "v1m Rev Latest (Calibrated)"
      },
      {
        "id": "v1m-decision-engine",
        "name": "v1m Decision Engine"
      }
    ]
  },
  {
    "id": "venice",
    "alias": "venice",
    "name": "Venice AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.venice.ai/api/v1",
    "models": [
      {
        "id": "venice-uncensored-1-2",
        "name": "Venice Uncensored 1.2"
      },
      {
        "id": "zai-org-glm-5",
        "name": "GLM-5"
      },
      {
        "id": "qwen3-235b-a22b-instruct-2507",
        "name": "Qwen3 235B A22B Instruct"
      },
      {
        "id": "qwen3-coder-480b-a35b-instruct-turbo",
        "name": "Qwen3 Coder 480B A35B Turbo"
      },
      {
        "id": "qwen3-vl-235b-a22b",
        "name": "Qwen3 VL 235B A22B"
      },
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro"
      },
      {
        "id": "llama-3.3-70b",
        "name": "Llama 3.3 70B"
      },
      {
        "id": "hermes-3-llama-3.1-405b",
        "name": "Hermes 3 Llama 3.1 405B"
      },
      {
        "id": "mistral-small-3-2-24b-instruct",
        "name": "Mistral Small 3.2 24B"
      },
      {
        "id": "text-embedding-3-large",
        "name": "Text Embedding 3 Large"
      },
      {
        "id": "text-embedding-bge-m3",
        "name": "BGE-M3 Embedding"
      },
      {
        "id": "text-embedding-qwen3-8b",
        "name": "Qwen3 8B Embedding"
      },
      {
        "id": "venice-sd35",
        "name": "Venice SD3.5"
      },
      {
        "id": "flux-2-pro",
        "name": "FLUX.2 Pro"
      },
      {
        "id": "gpt-image-2",
        "name": "GPT Image 2 (via Venice)"
      }
    ]
  },
  {
    "id": "veoaifree-web",
    "alias": "veo-free",
    "name": "Veo AI Free Web",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "veo",
        "name": "VEO 3.1 (Free)"
      },
      {
        "id": "seedance",
        "name": "Seedance (Free)"
      },
      {
        "id": "nano-banana",
        "name": "Nano Banana (Free)"
      }
    ]
  },
  {
    "id": "vercel-ai-gateway",
    "alias": "vercel",
    "name": "Vercel AI Gateway",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://ai-gateway.vercel.sh/v1",
    "models": [
      {
        "id": "default",
        "name": "Vercel AI Gateway Default"
      }
    ]
  },
  {
    "id": "vertex",
    "alias": "vx",
    "name": "Vertex AI",
    "category": "freeTier",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://aiplatform.googleapis.com",
    "models": [
      {
        "id": "gemini-4-argon",
        "name": "Gemini 4 Argon"
      },
      {
        "id": "gemini-3.1-pro-preview",
        "name": "Gemini 3.1 Pro Preview"
      },
      {
        "id": "gemini-3.1-flash-lite-preview",
        "name": "Gemini 3.1 Flash Lite Preview"
      },
      {
        "id": "gemini-3-flash-preview",
        "name": "Gemini 3 Flash Preview"
      },
      {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash"
      },
      {
        "id": "veo-3.1-generate-preview",
        "name": "Veo 3.1 (Preview)"
      },
      {
        "id": "veo-3.1-fast-generate-preview",
        "name": "Veo 3.1 Fast (Preview)"
      },
      {
        "id": "veo-3.0-generate-001",
        "name": "Veo 3"
      },
      {
        "id": "veo-2.0-generate-001",
        "name": "Veo 2"
      }
    ]
  },
  {
    "id": "vertex-partner",
    "alias": "vxp",
    "name": "Vertex Partner",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://aiplatform.googleapis.com",
    "models": [
      {
        "id": "deepseek-ai/deepseek-v3.2-maas",
        "name": "DeepSeek V3.2 (Vertex)"
      },
      {
        "id": "qwen/qwen3-next-80b-a3b-thinking-maas",
        "name": "Qwen3 Next 80B Thinking (Vertex)"
      },
      {
        "id": "qwen/qwen3-next-80b-a3b-instruct-maas",
        "name": "Qwen3 Next 80B Instruct (Vertex)"
      },
      {
        "id": "zai-org/glm-5-maas",
        "name": "GLM-5 (Vertex)"
      }
    ]
  },
  {
    "id": "volcengine-ark",
    "alias": "ark",
    "name": "Volcengine Ark",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "models": [
      {
        "id": "Doubao-Seed-2.0-Code",
        "name": "Doubao-Seed-2.0-Code"
      },
      {
        "id": "Doubao-Seed-2.0-pro",
        "name": "Doubao-Seed-2.0-pro"
      },
      {
        "id": "Doubao-Seed-2.0-lite",
        "name": "Doubao-Seed-2.0-lite"
      },
      {
        "id": "Doubao-Seed-Code",
        "name": "Doubao-Seed-Code"
      },
      {
        "id": "DeepSeek-V4-Flash",
        "name": "DeepSeek-V4-Flash"
      },
      {
        "id": "DeepSeek-V4-Pro",
        "name": "DeepSeek-V4-Pro"
      },
      {
        "id": "GLM-5.1",
        "name": "GLM-5.1"
      },
      {
        "id": "MiniMax-M2.7",
        "name": "MiniMax-M2.7"
      },
      {
        "id": "Kimi-K2.6",
        "name": "Kimi-K2.6"
      }
    ]
  },
  {
    "id": "voyage-ai",
    "alias": "voyage",
    "name": "Voyage AI",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "voyage-3-large",
        "name": "Voyage 3 Large"
      },
      {
        "id": "voyage-3.5",
        "name": "Voyage 3.5"
      },
      {
        "id": "voyage-3.5-lite",
        "name": "Voyage 3.5 Lite"
      },
      {
        "id": "voyage-code-3",
        "name": "Voyage Code 3"
      },
      {
        "id": "voyage-finance-2",
        "name": "Voyage Finance 2"
      },
      {
        "id": "voyage-law-2",
        "name": "Voyage Law 2"
      },
      {
        "id": "voyage-multilingual-2",
        "name": "Voyage Multilingual 2"
      }
    ]
  },
  {
    "id": "windsurf",
    "alias": "ws",
    "name": "Windsurf",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetChatMessage",
    "models": [
      {
        "id": "swe-1.6-fast",
        "name": "SWE-1.6 Fast"
      },
      {
        "id": "swe-1.6",
        "name": "SWE-1.6"
      },
      {
        "id": "swe-1.5-fast",
        "name": "SWE-1.5 Fast"
      },
      {
        "id": "swe-1.5",
        "name": "SWE-1.5"
      },
      {
        "id": "claude-opus-4.7-max",
        "name": "Claude Opus 4.7 Max"
      },
      {
        "id": "claude-opus-4.7-xhigh",
        "name": "Claude Opus 4.7 XHigh"
      },
      {
        "id": "claude-opus-4.7-high",
        "name": "Claude Opus 4.7 High"
      },
      {
        "id": "claude-opus-4.7-medium",
        "name": "Claude Opus 4.7 Medium"
      },
      {
        "id": "claude-opus-4.7-low",
        "name": "Claude Opus 4.7 Low"
      },
      {
        "id": "claude-opus-4.7-review",
        "name": "Claude Opus 4.7 Review"
      },
      {
        "id": "claude-sonnet-4.6-thinking-1m",
        "name": "Claude Sonnet 4.6 Thinking 1M"
      },
      {
        "id": "claude-sonnet-4.6-1m",
        "name": "Claude Sonnet 4.6 1M"
      },
      {
        "id": "claude-sonnet-4.6-thinking",
        "name": "Claude Sonnet 4.6 Thinking"
      },
      {
        "id": "claude-sonnet-4.6",
        "name": "Claude Sonnet 4.6"
      },
      {
        "id": "claude-opus-4.6-thinking",
        "name": "Claude Opus 4.6 Thinking"
      },
      {
        "id": "claude-opus-4.6",
        "name": "Claude Opus 4.6"
      },
      {
        "id": "claude-opus-4.5-thinking",
        "name": "Claude Opus 4.5 Thinking"
      },
      {
        "id": "claude-opus-4.5",
        "name": "Claude Opus 4.5"
      },
      {
        "id": "claude-sonnet-4.5-thinking",
        "name": "Claude Sonnet 4.5 Thinking"
      },
      {
        "id": "claude-sonnet-4.5",
        "name": "Claude Sonnet 4.5"
      },
      {
        "id": "claude-haiku-4.5",
        "name": "Claude Haiku 4.5"
      },
      {
        "id": "gpt-5.5-xhigh-fast",
        "name": "GPT-5.5 XHigh Fast"
      },
      {
        "id": "gpt-5.5-xhigh",
        "name": "GPT-5.5 XHigh"
      },
      {
        "id": "gpt-5.5-high-fast",
        "name": "GPT-5.5 High Fast"
      },
      {
        "id": "gpt-5.5-high",
        "name": "GPT-5.5 High"
      },
      {
        "id": "gpt-5.5-medium-fast",
        "name": "GPT-5.5 Medium Fast"
      },
      {
        "id": "gpt-5.5-medium",
        "name": "GPT-5.5 Medium"
      },
      {
        "id": "gpt-5.5-low-fast",
        "name": "GPT-5.5 Low Fast"
      },
      {
        "id": "gpt-5.5-low",
        "name": "GPT-5.5 Low"
      },
      {
        "id": "gpt-5.5-none-fast",
        "name": "GPT-5.5 None Fast"
      },
      {
        "id": "gpt-5.5-none",
        "name": "GPT-5.5 None"
      },
      {
        "id": "gpt-5.4-xhigh-fast",
        "name": "GPT-5.4 XHigh Fast"
      },
      {
        "id": "gpt-5.4-xhigh",
        "name": "GPT-5.4 XHigh"
      },
      {
        "id": "gpt-5.4-high-fast",
        "name": "GPT-5.4 High Fast"
      },
      {
        "id": "gpt-5.4-high",
        "name": "GPT-5.4 High"
      },
      {
        "id": "gpt-5.4-medium-fast",
        "name": "GPT-5.4 Medium Fast"
      },
      {
        "id": "gpt-5.4-medium",
        "name": "GPT-5.4 Medium"
      },
      {
        "id": "gpt-5.4-low-fast",
        "name": "GPT-5.4 Low Fast"
      },
      {
        "id": "gpt-5.4-low",
        "name": "GPT-5.4 Low"
      },
      {
        "id": "gpt-5.4-none-fast",
        "name": "GPT-5.4 None Fast"
      },
      {
        "id": "gpt-5.4-none",
        "name": "GPT-5.4 None"
      },
      {
        "id": "gpt-5.4-mini-xhigh",
        "name": "GPT-5.4 Mini XHigh"
      },
      {
        "id": "gpt-5.4-mini-high",
        "name": "GPT-5.4 Mini High"
      },
      {
        "id": "gpt-5.4-mini-medium",
        "name": "GPT-5.4 Mini Medium"
      },
      {
        "id": "gpt-5.4-mini-low",
        "name": "GPT-5.4 Mini Low"
      },
      {
        "id": "gpt-5.3-codex-xhigh-fast",
        "name": "GPT-5.3 Codex XHigh Fast"
      },
      {
        "id": "gpt-5.3-codex-xhigh",
        "name": "GPT-5.3 Codex XHigh"
      },
      {
        "id": "gpt-5.3-codex-high-fast",
        "name": "GPT-5.3 Codex High Fast"
      },
      {
        "id": "gpt-5.3-codex-high",
        "name": "GPT-5.3 Codex High"
      },
      {
        "id": "gpt-5.3-codex-medium-fast",
        "name": "GPT-5.3 Codex Medium Fast"
      },
      {
        "id": "gpt-5.3-codex-medium",
        "name": "GPT-5.3 Codex Medium"
      },
      {
        "id": "gpt-5.3-codex-low-fast",
        "name": "GPT-5.3 Codex Low Fast"
      },
      {
        "id": "gpt-5.3-codex-low",
        "name": "GPT-5.3 Codex Low"
      },
      {
        "id": "gpt-5.2-xhigh",
        "name": "GPT-5.2 XHigh"
      },
      {
        "id": "gpt-5.2-high",
        "name": "GPT-5.2 High"
      },
      {
        "id": "gpt-5.2-medium",
        "name": "GPT-5.2 Medium"
      },
      {
        "id": "gpt-5.2-low",
        "name": "GPT-5.2 Low"
      },
      {
        "id": "gpt-5.2-none",
        "name": "GPT-5.2 None"
      },
      {
        "id": "gpt-5",
        "name": "GPT-5"
      },
      {
        "id": "gpt-4.1",
        "name": "GPT-4.1"
      },
      {
        "id": "gpt-4.1-mini",
        "name": "GPT-4.1 Mini"
      },
      {
        "id": "gpt-4.1-nano",
        "name": "GPT-4.1 Nano"
      },
      {
        "id": "gpt-4o",
        "name": "GPT-4o"
      },
      {
        "id": "gpt-4o-mini",
        "name": "GPT-4o Mini"
      },
      {
        "id": "gemini-3.1-pro-high",
        "name": "Gemini 3.1 Pro High"
      },
      {
        "id": "gemini-3.1-pro-low",
        "name": "Gemini 3.1 Pro Low"
      },
      {
        "id": "gemini-3.0-flash-high",
        "name": "Gemini 3 Flash High"
      },
      {
        "id": "gemini-3.0-flash-medium",
        "name": "Gemini 3 Flash Medium"
      },
      {
        "id": "gemini-3.0-flash-low",
        "name": "Gemini 3 Flash Low"
      },
      {
        "id": "gemini-3.0-flash-minimal",
        "name": "Gemini 3 Flash Minimal"
      },
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro"
      },
      {
        "id": "deepseek-v4",
        "name": "DeepSeek V4"
      },
      {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6"
      },
      {
        "id": "kimi-k2.5",
        "name": "Kimi K2.5"
      },
      {
        "id": "glm-5.1",
        "name": "GLM-5.1"
      }
    ]
  },
  {
    "id": "xai",
    "alias": "xai",
    "name": "xAI (Grok)",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.x.ai/v1",
    "models": [
      {
        "id": "grok-4.7",
        "name": "Grok 4.7"
      },
      {
        "id": "grok-4.6",
        "name": "Grok 4.6"
      },
      {
        "id": "grok-4.5",
        "name": "Grok 4.5"
      },
      {
        "id": "grok-4",
        "name": "Grok 4"
      },
      {
        "id": "grok-4-fast-reasoning",
        "name": "Grok 4 Fast Reasoning"
      },
      {
        "id": "grok-code-fast-1",
        "name": "Grok Code Fast"
      },
      {
        "id": "grok-3",
        "name": "Grok 3"
      },
      {
        "id": "grok-2-image-1212",
        "name": "Grok 2 Image"
      },
      {
        "id": "grok-imagine-video",
        "name": "Grok Imagine Video"
      }
    ]
  },
  {
    "id": "xiaomi-mimo",
    "alias": "mimo",
    "name": "Xiaomi MiMo",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "models": [
      {
        "id": "mimo-v2.6-pro",
        "name": "MiMo V2.6 Pro"
      },
      {
        "id": "mimo-v2.6-flash",
        "name": "MiMo V2.6 Flash"
      },
      {
        "id": "mimo-v2.6-pro-ultraspeed",
        "name": "MiMo V2.6 Pro UltraSpeed"
      },
      {
        "id": "mimo-v2.5-pro",
        "name": "MiMo V2.5 Pro"
      },
      {
        "id": "mimo-v2.5",
        "name": "MiMo V2.5"
      },
      {
        "id": "mimo-v2-omni",
        "name": "MiMo V2 Omni"
      },
      {
        "id": "mimo-v2-flash",
        "name": "MiMo V2 Flash"
      },
      {
        "id": "mimo-v2.5-tts",
        "name": "MiMo V2.5 TTS"
      }
    ]
  },
  {
    "id": "xiaomi-tokenplan",
    "alias": "xmtp",
    "name": "Xiaomi MiMo (Token Plan)",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1",
    "models": [
      {
        "id": "mimo-v2.5-pro",
        "name": "MiMo V2.5 Pro"
      },
      {
        "id": "mimo-v2.5-pro-claude",
        "name": "MiMo V2.5 Pro (Claude Native)"
      },
      {
        "id": "mimo-v2.5",
        "name": "MiMo V2.5"
      },
      {
        "id": "mimo-v2-pro",
        "name": "MiMo V2 Pro"
      },
      {
        "id": "mimo-v2-omni",
        "name": "MiMo V2 Omni"
      },
      {
        "id": "mimo-v2-tts",
        "name": "MiMo V2 TTS"
      },
      {
        "id": "mimo-v2.5-tts",
        "name": "MiMo V2.5 TTS"
      },
      {
        "id": "mimo-v2.5-tts-voiceclone",
        "name": "MiMo V2.5 TTS Voice Clone"
      },
      {
        "id": "mimo-v2.5-tts-voicedesign",
        "name": "MiMo V2.5 TTS Voice Design"
      }
    ]
  },
  {
    "id": "xquik",
    "alias": "xquik",
    "name": "Xquik",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "Xquik Default"
      }
    ]
  },
  {
    "id": "youcom",
    "alias": "youcom",
    "name": "You.com Search",
    "category": "apikey",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.openai.com/v1",
    "models": [
      {
        "id": "default",
        "name": "You.com Search Default"
      }
    ]
  },
  {
    "id": "glm",
    "alias": "glm",
    "name": "Zai GLM Coding",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://api.z.ai/api/anthropic/v1",
    "models": [
      {
        "id": "glm-5.3",
        "name": "GLM 5.3"
      },
      {
        "id": "glm-5.3-flash",
        "name": "GLM 5.3 Flash (Vision)"
      },
      {
        "id": "glm-5.2",
        "name": "GLM 5.2"
      },
      {
        "id": "glm-5.1",
        "name": "GLM 5.1"
      },
      {
        "id": "glm-5-turbo",
        "name": "GLM 5 Turbo"
      },
      {
        "id": "glm-5",
        "name": "GLM 5"
      },
      {
        "id": "glm-4.7",
        "name": "GLM 4.7"
      },
      {
        "id": "glm-4.6v",
        "name": "GLM 4.6V (Vision)"
      }
    ]
  },
  {
    "id": "zed",
    "alias": "zd",
    "name": "Zed",
    "category": "oauth",
    "authMethods": [
      "api_key"
    ],
    "baseUrl": "https://cloud.zed.dev/completions",
    "models": [
      {
        "id": "default",
        "name": "Zed Default"
      }
    ]
  }
];

const BY_ID = new Map<string, XGatewayCatalogProvider>();
const BY_ALIAS = new Map<string, XGatewayCatalogProvider>();

for (const entry of X_GATEWAY_PROVIDERS) {
  BY_ID.set(entry.id.toLowerCase(), entry);
  BY_ALIAS.set(entry.alias.toLowerCase(), entry);
}
// Common aliases for compatibility across 9Router and FreeLLMAPI
if (BY_ID.has('github-copilot')) BY_ALIAS.set('github', BY_ID.get('github-copilot')!);
if (BY_ID.has('gemini')) BY_ALIAS.set('google', BY_ID.get('gemini')!);
if (BY_ID.has('kilo-gateway')) BY_ALIAS.set('kilo', BY_ID.get('kilo-gateway')!);
if (BY_ID.has('volcengine-ark')) BY_ALIAS.set('volcengine', BY_ID.get('volcengine-ark')!);
if (BY_ID.has('baidu')) BY_ALIAS.set('qianfan', BY_ID.get('baidu')!);

export interface CustomProviderNode {
  id: string;
  name: string;
  prefix: string;
  type: 'openai-compatible' | 'anthropic-compatible' | 'custom-embedding';
  apiType?: 'chat' | 'responses';
  baseUrl: string;
  models?: string[];
}

let customNodesGetter: (() => CustomProviderNode[]) | null = null;
export function registerCustomNodesGetter(fn: () => CustomProviderNode[]): void {
  customNodesGetter = fn;
}

export function listXGatewayProviders(): readonly XGatewayCatalogProvider[] {
  const customNodes = customNodesGetter ? customNodesGetter() : [];
  if (!customNodes || customNodes.length === 0) {
    return X_GATEWAY_PROVIDERS;
  }
  const customCatalogProviders: XGatewayCatalogProvider[] = customNodes.map(node => ({
    id: node.id,
    alias: node.prefix,
    name: node.name,
    category: 'apikey' as ProviderCategory,
    authMethods: ['api_key'],
    baseUrl: node.baseUrl,
    models: (node.models || []).map(m => ({ id: m, name: m })),
  }));
  return [...X_GATEWAY_PROVIDERS, ...customCatalogProviders];
}

export function getXGatewayProvider(idOrAlias: string): XGatewayCatalogProvider | undefined {
  const key = idOrAlias.trim().toLowerCase();
  const builtin = BY_ID.get(key) ?? BY_ALIAS.get(key);
  if (builtin) return builtin;
  if (customNodesGetter) {
    const nodes = customNodesGetter();
    const node = nodes.find(n => n.id.toLowerCase() === key || n.prefix.toLowerCase() === key);
    if (node) {
      return {
        id: node.id,
        alias: node.prefix,
        name: node.name,
        category: 'apikey' as ProviderCategory,
        authMethods: ['api_key'],
        baseUrl: node.baseUrl,
        models: (node.models || []).map(m => ({ id: m, name: m })),
      };
    }
  }
  return undefined;
}

export function normalizeXGatewayProviderId(idOrAlias: string): string | null {
  return getXGatewayProvider(idOrAlias)?.id ?? null;
}

export function platformForXGatewayProvider(providerId: string): Platform {
  const normalized = normalizeXGatewayProviderId(providerId) ?? providerId;
  if (normalized === 'github-copilot' || normalized === 'custom') return 'custom';
  if (normalized === 'gemini' || normalized === 'google') return 'google';
  if (normalized === 'kilo-gateway') return 'kilo';
  if (normalized === 'volcengine-ark') return 'volcengine';
  if (normalized === 'baidu') return 'qianfan';
  const builtin = resolveProvider(normalized as Platform);
  return builtin ? (normalized as Platform) : 'custom';
}

export const X_GATEWAY_OAUTH_EXECUTORS = new Set(['codex', 'claude', 'gemini-cli', 'kiro', 'github-copilot', 'openrouter', 'qoder', 'qoder-cn', 'glm']);

export function resolveXGatewayProvider(
  providerId: string,
  baseUrl?: string | null,
  extraHeaders?: Record<string, string>,
): BaseProvider | undefined {
  const normalized = normalizeXGatewayProviderId(providerId) ?? providerId;
  const trimmedUrl = baseUrl?.trim() || null;
  const hasExtraHeaders = Boolean(extraHeaders && Object.keys(extraHeaders).length > 0);

  if (normalized === 'codex') return new CodexProvider();
  if (normalized === 'gemini-cli') return new GeminiCliProvider();
  if (normalized === 'kiro') return new KiroProvider();

  if (normalized === 'github-copilot' || trimmedUrl === COPILOT_BASE_URL) {
    return new CopilotProvider();
  }
  if (normalized === 'gemini' || normalized === 'google') {
    return resolveProvider('google', trimmedUrl);
  }
  if (normalized === 'custom') {
    if (!trimmedUrl) return undefined;
    if (hasExtraHeaders) {
      return new OpenAICompatProvider({
        platform: 'custom',
        name: 'Custom Endpoint',
        baseUrl: trimmedUrl,
        extraHeaders,
        timeoutMs: 120_000,
      });
    }
    return resolveProvider('custom', trimmedUrl);
  }
  if (normalized === 'qoder' || normalized === 'qoder-cn') {
    return new QoderProvider(normalized);
  }

  const catalogEntry = getXGatewayProvider(normalized);
  if (catalogEntry?.category === 'oauth' && !X_GATEWAY_OAUTH_EXECUTORS.has(normalized)) return undefined;
  if (normalized === 'claude') return new AnthropicWireProvider({ name: catalogEntry?.name ?? 'Claude', baseUrl: trimmedUrl ?? 'https://api.anthropic.com/v1', timeoutMs: 120_000, extraHeaders });
  const effectiveUrl = trimmedUrl ?? catalogEntry?.baseUrl?.trim();

  if (customNodesGetter) {
    const nodes = customNodesGetter();
    const customNode = nodes.find(n => n.id.toLowerCase() === normalized.toLowerCase() || n.prefix.toLowerCase() === normalized.toLowerCase());
    if (customNode && effectiveUrl) {
      if (customNode.type === 'anthropic-compatible') {
        return new AnthropicWireProvider({
          name: customNode.name,
          baseUrl: effectiveUrl,
          timeoutMs: 120_000,
          extraHeaders,
        });
      }
      return new OpenAICompatProvider({
        platform: 'custom',
        name: customNode.name,
        baseUrl: effectiveUrl,
        extraHeaders,
        timeoutMs: 120_000,
      });
    }
  }

  if (catalogEntry?.category === 'webCookie' && effectiveUrl) {
    return new WebCookieProvider({
      providerId: catalogEntry.id,
      name: catalogEntry.name,
      baseUrl: effectiveUrl,
      timeoutMs: 120_000,
    });
  }

  if (
    effectiveUrl &&
    (normalized === 'claude' ||
      normalized === 'glm' ||
      effectiveUrl.includes('api.anthropic.com') ||
      effectiveUrl.includes('/anthropic/v1'))
  ) {
    return new AnthropicWireProvider({
      name: catalogEntry?.name ?? normalized,
      baseUrl: effectiveUrl,
      timeoutMs: 120_000,
      extraHeaders,
    });
  }

  if ((trimmedUrl && catalogEntry && trimmedUrl !== catalogEntry.baseUrl) || (hasExtraHeaders && effectiveUrl)) {
    return new OpenAICompatProvider({
      platform: 'custom',
      name: catalogEntry?.name ?? normalized,
      baseUrl: effectiveUrl!,
      extraHeaders,
      timeoutMs: 120_000,
    });
  }

  const mappedPlatform = platformForXGatewayProvider(normalized);
  if (mappedPlatform !== 'custom') {
    const builtin = resolveProvider(mappedPlatform, trimmedUrl);
    if (builtin) return builtin;
  }

  if (!effectiveUrl) return undefined;

  return new OpenAICompatProvider({
    platform: 'custom',
    name: catalogEntry?.name ?? normalized,
    baseUrl: effectiveUrl,
    extraHeaders,
    timeoutMs: 120_000,
  });
}
