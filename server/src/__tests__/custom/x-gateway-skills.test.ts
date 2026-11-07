import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { initDb } from '../../db/index.js';
import { skillsService } from '../../custom/x-gateway/skills-service.js';
import { xSkillsRouter, xSkillsPublicRouter } from '../../custom/x-gateway/skills-router.js';

describe('X Gateway Agent Skills Hub', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    const app = express();
    app.use(express.json());
    app.use('/api/x-gateway/skills', xSkillsRouter);
    app.use('/x-skills', xSkillsPublicRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          base = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    try {
      skillsService.deleteCustomSkill('test-custom-agent-skill');
      skillsService.deleteCustomSkill('another-test-skill');
    } catch {
      // ignore
    }
  });

  describe('SkillsService', () => {
    it('lists all built-in skills with valid metadata and token estimates', () => {
      const result = skillsService.listSkills({ baseUrl: 'http://test-gateway:3001' });
      expect(result.skills.length).toBeGreaterThanOrEqual(9);

      const entry = result.skills.find((s) => s.id === '9router');
      expect(entry).toBeDefined();
      expect(entry?.isEntry).toBe(true);
      expect(entry?.name).toContain('9Router');
      expect(entry?.content).toContain('http://test-gateway:3001');
      expect(entry?.tokenEstimate).toBeGreaterThan(50);
      expect(entry?.promptSnippet).toContain('Read this skill and use it:');

      const chat = result.skills.find((s) => s.id === '9router-chat');
      expect(chat).toBeDefined();
      expect(chat?.endpoint).toBe('/v1/chat/completions');
      expect(chat?.category).toBe('chat');
    });

    it('returns raw markdown for a built-in skill with variable substitution', () => {
      const raw = skillsService.getRawSkillMarkdown('9router-image', { baseUrl: 'https://proxy.example.com' });
      expect(raw).toBeDefined();
      expect(raw).toContain('POST https://proxy.example.com/v1/images/generations');
    });

    it('returns null for an invalid skill id', () => {
      const result = skillsService.getSkill('non-existent-skill-id-12345');
      expect(result).toBeNull();

      const raw = skillsService.getRawSkillMarkdown('non-existent-skill-id-12345');
      expect(raw).toBeNull();
    });

    it('supports full CRUD lifecycle for custom skills', () => {
      // Create
      const created = skillsService.createCustomSkill({
        id: 'test-custom-agent-skill',
        name: 'Test Team Rules',
        category: 'custom',
        description: 'Mandatory coding guidelines and persona for team agents.',
        endpoint: '/v1/chat/completions',
        icon: 'Sparkles',
        content: '# Team Coding Rules\n\nAlways use TypeScript strict mode and write unit tests.',
      });

      expect(created.id).toBe('test-custom-agent-skill');
      expect(created.name).toBe('Test Team Rules');

      // Reject duplicate creation
      expect(() => {
        skillsService.createCustomSkill({
          id: 'test-custom-agent-skill',
          name: 'Duplicate',
          description: 'Duplicate',
          content: 'Duplicate',
        });
      }).toThrow(/already exists/);

      // Reject collision with builtin
      expect(() => {
        skillsService.createCustomSkill({
          id: '9router',
          name: 'Collision',
          description: 'Collision',
          content: 'Collision',
        });
      }).toThrow(/collides with a built-in skill/);

      // Read
      const retrieved = skillsService.getSkill('test-custom-agent-skill');
      expect(retrieved).toBeDefined();
      expect(retrieved?.isCustom).toBe(true);
      expect(retrieved?.name).toBe('Test Team Rules');

      // Update
      const updated = skillsService.updateCustomSkill('test-custom-agent-skill', {
        name: 'Updated Team Rules',
        description: 'Updated guidelines for agents.',
      });
      expect(updated.name).toBe('Updated Team Rules');
      expect(updated.description).toBe('Updated guidelines for agents.');

      // Delete
      const deleted = skillsService.deleteCustomSkill('test-custom-agent-skill');
      expect(deleted).toBe(true);

      const afterDelete = skillsService.getSkill('test-custom-agent-skill');
      expect(afterDelete).toBeNull();

      // Delete again returns false
      const deletedAgain = skillsService.deleteCustomSkill('test-custom-agent-skill');
      expect(deletedAgain).toBe(false);
    });
  });

  describe('Skills Router API Endpoints', () => {
    it('GET /api/x-gateway/skills returns skill collection', async () => {
      const res = await fetch(`${base}/api/x-gateway/skills`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.skills).toBeInstanceOf(Array);
      expect(data.skills.length).toBeGreaterThanOrEqual(9);
      expect(data.resolvedBaseUrl).toBeDefined();
    });

    it('GET /api/x-gateway/skills/:id returns single skill detail', async () => {
      const res = await fetch(`${base}/api/x-gateway/skills/9router`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.skill).toBeDefined();
      expect(data.skill.id).toBe('9router');
      expect(data.skill.content).toContain('# 9Router');
    });

    it('GET /api/x-gateway/skills/:id returns 404 for unknown skill', async () => {
      const res = await fetch(`${base}/api/x-gateway/skills/unknown-skill-xyz`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.type).toBe('not_found');
    });

    it('GET /api/x-gateway/skills/:id/raw returns text/markdown with CORS headers', async () => {
      const res = await fetch(`${base}/api/x-gateway/skills/9router-chat/raw`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/markdown');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const text = await res.text();
      expect(text).toContain('name: 9router-chat');
    });

    it('GET /x-skills/:id and /x-skills/:id/SKILL.md public agent endpoint works', async () => {
      const res1 = await fetch(`${base}/x-skills/9router/SKILL.md`);
      expect(res1.status).toBe(200);
      expect(res1.headers.get('content-type')).toContain('text/markdown');
      const text1 = await res1.text();
      expect(text1).toContain('# 9Router');

      const res2 = await fetch(`${base}/x-skills/9router`);
      expect(res2.status).toBe(200);
      expect(res2.headers.get('content-type')).toContain('text/markdown');
    });

    it('POST, PUT, DELETE custom skills via console API', async () => {
      const createRes = await fetch(`${base}/api/x-gateway/skills/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'another-test-skill',
          name: 'API Guidelines',
          category: 'tools',
          description: 'REST API design conventions for automated workers.',
          content: '# API Rules\n\nAlways return standard JSON envelopes with request IDs.',
        }),
      });

      expect(createRes.status).toBe(201);
      const createData = await createRes.json();
      expect(createData.skill.id).toBe('another-test-skill');

      const updateRes = await fetch(`${base}/api/x-gateway/skills/custom/another-test-skill`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'REST API Guidelines v2',
        }),
      });
      expect(updateRes.status).toBe(200);
      const updateData = await updateRes.json();
      expect(updateData.skill.name).toBe('REST API Guidelines v2');

      const deleteRes = await fetch(`${base}/api/x-gateway/skills/custom/another-test-skill`, {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(200);
      const deleteData = await deleteRes.json();
      expect(deleteData.ok).toBe(true);
    });
  });
});
