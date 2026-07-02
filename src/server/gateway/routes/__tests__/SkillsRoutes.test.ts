/**
 * SkillsRoutes.test.ts — CRUD API routes for skills
 *
 * Tests cover:
 *   1. CreateSkillRoute — POST /api/v1/skills
 *   2. PatchSkillRoute — PATCH /api/v1/skills/:name (update desc/content)
 *   3. PatchSkillRoute — PATCH /api/v1/skills/:name (toggle enabled)
 *   4. DeleteSkillRoute — DELETE /api/v1/skills/:name
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import { existsSync, unlinkSync } from 'fs';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SkillManager } from '../../../core/skills/SkillManager.js';
import { SkillSource } from '../../../core/skills/Skill.js';
import { CreateSkillRoute, PatchSkillRoute, DeleteSkillRoute } from '../SkillsRoutes.js';

const TMP_DIR = path.resolve(process.cwd(), '.test-skills-routes');

// Capture response data
interface Capture {
  status: number;
  body: Record<string, unknown>;
}

function mockReq(bodyObj: Record<string, unknown>): IncomingMessage {
  const bodyStr = JSON.stringify(bodyObj);
  const chunks = [Buffer.from(bodyStr)];
  return {
    on: (ev: string, cb: (...args: unknown[]) => void) => {
      if (ev === 'data') {
        for (const c of chunks) cb(c);
      }
      if (ev === 'end') cb();
      return mockReq({}) as unknown as IncomingMessage;
    },
    headers: {},
    method: 'POST',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

function mockRes(capture: Capture): ServerResponse {
  return {
    writeHead: (status: number) => { capture.status = status; },
    end: (data?: string) => {
      if (data) {
        try { capture.body = JSON.parse(data); }
        catch { capture.body = { raw: data }; }
      }
    },
    setHeader: () => {},
    getHeader: () => undefined,
  } as unknown as ServerResponse;
}

describe('SkillsRoutes', () => {

  beforeAll(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
  });

  afterAll(async () => {
    SkillManager.resetInstance();
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    SkillManager.resetInstance();
    await fs.rm(TMP_DIR, { recursive: true, force: true });
    await fs.mkdir(TMP_DIR, { recursive: true });

    // Clean persisted disabled state to avoid cross-test contamination
    const disabledFile = path.resolve(process.cwd(), 'data', 'disabled-skills.json');
    try { unlinkSync(disabledFile); } catch { /* ok */ }

    // Load TMP_DIR as the project skills directory for auto-detection in route handlers
    const sm = SkillManager.getInstance();
    await sm.loadFromDirectory(TMP_DIR, SkillSource.Project);
  });

  describe('CreateSkillRoute', () => {

    it('creates a skill and returns 201', async () => {
      const route = new CreateSkillRoute();
      const capture: Capture = { status: 0, body: {} };
      const req = mockReq({ name: 'route-test', description: 'Route test', content: '# Route' });
      const res = mockRes(capture);
      const match = { segments: ['api', 'v1', 'skills'], params: {}, query: new URLSearchParams() };

      await route.handle(match, req, res, null);

      expect(capture.status).toBe(201);
      expect(capture.body).toHaveProperty('id');
      expect(capture.body).toHaveProperty('status', 'created');

      // Verify skill was registered
      const skill = SkillManager.getInstance().getSkill('route-test');
      expect(skill).toBeTruthy();
      expect(skill!.description()).toBe('Route test');
    });

    it('returns 400 for missing name', async () => {
      const route = new CreateSkillRoute();
      const capture: Capture = { status: 0, body: {} };
      const req = mockReq({ description: 'No name', content: '# Oops' });
      const res = mockRes(capture);
      const match = { segments: ['api', 'v1', 'skills'], params: {}, query: new URLSearchParams() };

      await route.handle(match, req, res, null);

      expect(capture.status).toBe(400);
    });

  });

  describe('PatchSkillRoute', () => {

    it('updates skill description and content', async () => {
      // Create skill first (auto-detects TMP_DIR from loaded dirs)
      const sm = SkillManager.getInstance();
      await sm.createSkill('patch-test', 'Original', '# Orig');

      const route = new PatchSkillRoute();
      const capture: Capture = { status: 0, body: {} };
      const req = mockReq({ description: 'Updated', content: '# Updated' });
      const res = mockRes(capture);
      const match = { segments: ['api', 'v1', 'skills', 'patch-test'], params: { name: 'patch-test' }, query: new URLSearchParams() };

      await route.handle(match, req, res, null);

      expect(capture.status).toBe(200);
      expect(sm.getSkill('patch-test')!.description()).toBe('Updated');
      expect(sm.getSkill('patch-test')!.body()).toBe('# Updated');
    });

    it('toggles skill enabled state', async () => {
      const sm = SkillManager.getInstance();
      await sm.createSkill('toggle-test', 'Toggle', '# T');
      expect(sm.isEnabled('toggle-test')).toBe(true);

      const route = new PatchSkillRoute();
      const capture: Capture = { status: 0, body: {} };
      const req = mockReq({ enabled: false });
      const res = mockRes(capture);
      const match = { segments: ['api', 'v1', 'skills', 'toggle-test'], params: { name: 'toggle-test' }, query: new URLSearchParams() };

      await route.handle(match, req, res, null);

      expect(capture.status).toBe(200);
      expect(sm.isEnabled('toggle-test')).toBe(false);
    });

    it('returns 404 for nonexistent skill', async () => {
      const route = new PatchSkillRoute();
      const capture: Capture = { status: 0, body: {} };
      const req = mockReq({ description: 'Nope' });
      const res = mockRes(capture);
      const match = { segments: ['api', 'v1', 'skills', 'no-such-skill'], params: { name: 'no-such-skill' }, query: new URLSearchParams() };

      await route.handle(match, req, res, null);

      expect(capture.status).toBe(404);
    });

  });

  describe('DeleteSkillRoute', () => {

    it('deletes a skill and returns 200', async () => {
      const sm = SkillManager.getInstance();
      await sm.createSkill('delete-route', 'Delete', '# Gone');

      const route = new DeleteSkillRoute();
      const capture: Capture = { status: 0, body: {} };
      const req = mockReq({});
      const res = mockRes(capture);
      const match = { segments: ['api', 'v1', 'skills', 'delete-route'], params: { name: 'delete-route' }, query: new URLSearchParams() };

      await route.handle(match, req, res, null);

      expect(capture.status).toBe(200);
      expect(sm.getSkill('delete-route')).toBeUndefined();
    });

    it('returns 404 for nonexistent skill', async () => {
      const route = new DeleteSkillRoute();
      const capture: Capture = { status: 0, body: {} };
      const req = mockReq({});
      const res = mockRes(capture);
      const match = { segments: ['api', 'v1', 'skills', 'no-such'], params: { name: 'no-such' }, query: new URLSearchParams() };

      await route.handle(match, req, res, null);

      expect(capture.status).toBe(404);
    });

  });

});
