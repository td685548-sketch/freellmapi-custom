// Client-side model pricing math shared by the usage pages (AccountUsage,
// ConsoleLog). Own module so AccountUsage.tsx only exports the page component
// (react-refresh rule).
export interface ModelPricingRate {
  input: number
  output: number
  cached?: number
  reasoning?: number
  cache_creation?: number
}

export type ProviderPricingMap = Record<string, Record<string, ModelPricingRate>>

const FALLBACK_RATE: ModelPricingRate = {
  input: 1.0,
  output: 3.0,
  cached: 0.5,
  reasoning: 3.0,
}

export function resolveClientModelPricing(
  provider: string | undefined,
  model: string | undefined,
  pricingMap: ProviderPricingMap | undefined,
): ModelPricingRate {
  const normProvider = (provider ?? '').trim().toLowerCase()
  const rawModel = (model ?? '').trim()

  if (rawModel.toLowerCase().includes(':free') || rawModel.toLowerCase().startsWith('cline-free/')) {
    return { input: 0, output: 0, cached: 0, reasoning: 0 }
  }

  if (pricingMap) {
    if (normProvider && rawModel && pricingMap[normProvider]?.[rawModel]) {
      return pricingMap[normProvider][rawModel]
    }
    const slashIdx = rawModel.indexOf('/')
    const stripped = slashIdx >= 0 ? rawModel.slice(slashIdx + 1) : rawModel
    const prefix = slashIdx > 0 ? rawModel.slice(0, slashIdx).toLowerCase() : ''

    if (normProvider && stripped && pricingMap[normProvider]?.[stripped]) {
      return pricingMap[normProvider][stripped]
    }
    if (prefix && stripped && pricingMap[prefix]?.[stripped]) {
      return pricingMap[prefix][stripped]
    }
    for (const models of Object.values(pricingMap)) {
      if (rawModel && models[rawModel]) return models[rawModel]
      if (stripped && models[stripped]) return models[stripped]
    }
    if (normProvider && pricingMap[normProvider]) {
      const entries = Object.values(pricingMap[normProvider])
      if (entries.length > 0) {
        const avgIn = entries.reduce((s, e) => s + e.input, 0) / entries.length
        const avgOut = entries.reduce((s, e) => s + e.output, 0) / entries.length
        return { input: avgIn, output: avgOut }
      }
    }
  }

  return FALLBACK_RATE
}

export function calculateTokenCostDollars(
  provider: string | undefined,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  pricingMap: ProviderPricingMap | undefined,
): number {
  const rate = resolveClientModelPricing(provider, model, pricingMap)
  const inTok = Math.max(0, Number(inputTokens) || 0)
  const outTok = Math.max(0, Number(outputTokens) || 0)
  return (inTok * rate.input + outTok * rate.output) / 1_000_000
}

export function calculateBlendedTokensCostDollars(
  provider: string | undefined,
  model: string | undefined,
  totalTokens: number,
  pricingMap: ProviderPricingMap | undefined,
): number {
  const tok = Math.max(0, Number(totalTokens) || 0)
  if (tok === 0) return 0
  // Standard 70% input / 30% output blend when only total token count is stored
  const inputTokens = tok * 0.7
  const outputTokens = tok * 0.3
  return calculateTokenCostDollars(provider, model, inputTokens, outputTokens, pricingMap)
}

export const fmtDollars = (dollars: number) => {
  if (!dollars || dollars <= 0) return '$0.00'
  if (dollars < 0.0001) return `$${dollars.toFixed(6)}`
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`
  return `$${dollars.toFixed(2)}`
}
