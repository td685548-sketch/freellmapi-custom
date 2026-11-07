import { getDb } from '../../db/index.js';
import { BUILTIN_SKILLS, type BuiltinSkillDefinition } from './skills-builtin.js';
import { tunnelService } from './tunnel-service.js';

export interface CustomSkill {
  id: string;
  name: string;
  category: 'entry' | 'chat' | 'media' | 'audio' | 'data' | 'search' | 'tools' | 'custom';
  description: string;
  endpoint: string | null;
  icon: string;
  content: string;
  createdBy?: number | null;
  createdAt: string;
  updatedAt: string;
}

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

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills';

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text || '').length / 3.8));
}

function resolveBaseUrl(options?: { baseUrl?: string; origin?: string }): string {
  if (options?.baseUrl) return options.baseUrl.replace(/\/+$/, '');
  const tunnelStatus = tunnelService.getStatus();
  if (tunnelStatus.state === 'active' && tunnelStatus.url) {
    return tunnelStatus.url.replace(/\/+$/, '');
  }
  if (options?.origin) {
    return options.origin.replace(/\/+$/, '');
  }
  return 'http://localhost:3001';
}

function replaceTemplateVars(content: string, baseUrl: string): string {
  return content
    .replace(/\{\{GATEWAY_URL\}\}/g, baseUrl)
    .replace(/\$\{GATEWAY_URL\}/g, baseUrl)
    .replace(/\$GATEWAY_URL/g, baseUrl)
    .replace(/http:\/\/localhost:20128/g, baseUrl);
}

export class SkillsService {
  private loadCustomSkills(): CustomSkill[] {
    try {
      const db = getDb();
      const row = db.prepare("SELECT value FROM x_gateway_config WHERE key = 'custom_skills'").get() as
        | { value: string }
        | undefined;
      if (!row?.value) return [];
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveCustomSkills(skills: CustomSkill[]): void {
    const db = getDb();
    const now = new Date().toISOString();
    const value = JSON.stringify(skills);
    db.prepare(
      `INSERT INTO x_gateway_config (key, value, updated_at) VALUES ('custom_skills', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(value, now);
  }

  public listSkills(options?: { baseUrl?: string; origin?: string }): SkillsListResponse {
    const baseUrl = resolveBaseUrl(options);
    const tunnelStatus = tunnelService.getStatus();
    const customList = this.loadCustomSkills();

    const builtins: SkillSummary[] = BUILTIN_SKILLS.map((b: BuiltinSkillDefinition) => {
      const replacedContent = replaceTemplateVars(b.content, baseUrl);
      const rawUrl = `${baseUrl}/api/x-gateway/skills/${b.id}/raw`;
      return {
        id: b.id,
        name: b.name,
        category: b.category,
        description: b.description,
        endpoint: b.endpoint,
        icon: b.icon,
        isEntry: Boolean(b.isEntry),
        isCustom: false,
        rawUrl,
        publicUrl: `${baseUrl}/x-skills/${b.id}/SKILL.md`,
        githubUrl: `${GITHUB_RAW_BASE}/${b.githubPath}`,
        tokenEstimate: estimateTokens(replacedContent),
        promptSnippet: `Read this skill and use it: ${rawUrl}`,
        content: replacedContent,
      };
    });

    const customs: SkillSummary[] = customList.map((c) => {
      const replacedContent = replaceTemplateVars(c.content, baseUrl);
      const rawUrl = `${baseUrl}/api/x-gateway/skills/${c.id}/raw`;
      return {
        id: c.id,
        name: c.name,
        category: c.category || 'custom',
        description: c.description,
        endpoint: c.endpoint || null,
        icon: c.icon || 'Code',
        isEntry: false,
        isCustom: true,
        rawUrl,
        publicUrl: `${baseUrl}/x-skills/${c.id}/SKILL.md`,
        githubUrl: '',
        tokenEstimate: estimateTokens(replacedContent),
        promptSnippet: `Read this skill and use it: ${rawUrl}`,
        content: replacedContent,
        updatedAt: c.updatedAt,
      };
    });

    return {
      skills: [...builtins, ...customs],
      tunnelActive: tunnelStatus.state === 'active' && Boolean(tunnelStatus.url),
      tunnelUrl: tunnelStatus.url,
      resolvedBaseUrl: baseUrl,
    };
  }

  public getSkill(id: string, options?: { baseUrl?: string; origin?: string }): SkillSummary | null {
    const list = this.listSkills(options);
    return list.skills.find((s) => s.id === id) || null;
  }

  public getRawSkillMarkdown(id: string, options?: { baseUrl?: string; origin?: string }): string | null {
    const skill = this.getSkill(id, options);
    return skill ? skill.content : null;
  }

  public createCustomSkill(input: {
    id: string;
    name: string;
    category?: CustomSkill['category'];
    description: string;
    endpoint?: string | null;
    icon?: string;
    content: string;
    userId?: number;
  }): CustomSkill {
    const sanitizedId = input.id.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
    if (!sanitizedId) throw new Error('Skill ID is required and must contain alphanumeric characters.');

    if (BUILTIN_SKILLS.some((b) => b.id === sanitizedId)) {
      throw new Error(`Skill ID '${sanitizedId}' collides with a built-in skill.`);
    }

    const current = this.loadCustomSkills();
    if (current.some((c) => c.id === sanitizedId)) {
      throw new Error(`Custom skill with ID '${sanitizedId}' already exists.`);
    }

    const now = new Date().toISOString();
    const newSkill: CustomSkill = {
      id: sanitizedId,
      name: input.name.trim(),
      category: input.category || 'custom',
      description: input.description.trim(),
      endpoint: input.endpoint ? input.endpoint.trim() : null,
      icon: input.icon || 'Code',
      content: input.content,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    };

    current.push(newSkill);
    this.saveCustomSkills(current);
    return newSkill;
  }

  public updateCustomSkill(
    id: string,
    patch: {
      name?: string;
      category?: CustomSkill['category'];
      description?: string;
      endpoint?: string | null;
      icon?: string;
      content?: string;
    }
  ): CustomSkill {
    const current = this.loadCustomSkills();
    const idx = current.findIndex((c) => c.id === id);
    if (idx === -1) {
      throw new Error(`Custom skill '${id}' not found.`);
    }

    const existing = current[idx]!;
    const updated: CustomSkill = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      category: patch.category !== undefined ? patch.category : existing.category,
      description: patch.description !== undefined ? patch.description.trim() : existing.description,
      endpoint: patch.endpoint !== undefined ? (patch.endpoint ? patch.endpoint.trim() : null) : existing.endpoint,
      icon: patch.icon !== undefined ? patch.icon : existing.icon,
      content: patch.content !== undefined ? patch.content : existing.content,
      updatedAt: new Date().toISOString(),
    };

    current[idx] = updated;
    this.saveCustomSkills(current);
    return updated;
  }

  public deleteCustomSkill(id: string): boolean {
    const current = this.loadCustomSkills();
    const filtered = current.filter((c) => c.id !== id);
    if (filtered.length === current.length) return false;
    this.saveCustomSkills(filtered);
    return true;
  }
}

export const skillsService = new SkillsService();
