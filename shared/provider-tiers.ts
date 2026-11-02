export type ProviderTier = 'S' | 'A' | 'B' | 'C' | 'D';
export type ProviderTierRange = '24h' | '7d' | '30d' | '90d' | 'all';

export interface ProviderTierRow {
  providerId: string;
  platform: string;
  name: string;
  linkedKeyCount: number;
  usableKeyCount: number;
  samples: number;
  successes: number;
  modelCount: number;
  reliability: number | null;
  speed: number | null;
  intelligence: number | null;
  score: number | null;
  tier: ProviderTier | null;
}

export interface ProviderTiersResponse {
  range: ProviderTierRange;
  generatedAt: string;
  minSamples: number;
  rows: ProviderTierRow[];
}
