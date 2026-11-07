export type SkillCategory = 'all' | 'entry' | 'chat' | 'media' | 'audio' | 'data' | 'search' | 'tools' | 'custom';

export interface SkillSummary {
  id: string;
  name: string;
  category: 'entry' | 'chat' | 'media' | 'audio' | 'data' | 'search' | 'tools' | 'custom';
  description: string;
  endpoint: string | null;
  icon: string;
  isEntry: boolean;
  isCustom: boolean;
  rawUrl: string;
  publicUrl: string;
  githubUrl: string;
  tokenEstimate: number;
  promptSnippet: string;
  content: string;
  updatedAt?: string;
}

export interface SkillsListResponse {
  skills: SkillSummary[];
  tunnelActive: boolean;
  tunnelUrl: string | null;
  resolvedBaseUrl: string;
}

export interface CustomSkillCreateInput {
  id: string;
  name: string;
  category?: string;
  description: string;
  endpoint?: string | null;
  icon?: string;
  content: string;
}

export interface CustomSkillUpdateInput {
  name?: string;
  category?: string;
  description?: string;
  endpoint?: string | null;
  icon?: string;
  content?: string;
}

