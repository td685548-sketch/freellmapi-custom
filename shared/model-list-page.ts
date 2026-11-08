/** Dashboard-only paging metadata. A page counts logical groups, not providers. */
export interface ModelListPageInfo {
  snapshot: string;
  nextOffset: number | null;
  totalGroups: number;
  matchedGroups: number;
  ranks: Record<string, number>;
  groupKeys: string[];
  unconfiguredPlatforms: string[];
  tokenSummary: { totalBudget: number; totalUsed: number };
}
