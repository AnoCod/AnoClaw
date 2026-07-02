/**
 * SkillManager.test.ts — CRUD + toggle for skills
 *
 * Tests cover:
 *   1. createSkill — creates directory + SKILL.md, registers in manager
 *   2. updateSkill — updates SKILL.md content and re-registers
 *   3. deleteSkill — removes directory and unregisters
 *   4. toggleSkill — enables/disables skill, persists state
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SkillManager } from '../SkillManager.js';
import { SkillSource } from '../Skill.js';

const TMP_DIR = path.resolve(process.cwd(), '.test-skills-crud');
let manager: SkillManager;

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset singleton and create fresh manager
  SkillManager.resetInstance();
  // Clean and recreate the temp skills directory
  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  manager = SkillManager.getInstance();
});

describe('SkillManager CRUD', () => {

  describe('createSkill', () => {

    it('creates a skill file and registers it in the manager', async () => {
      await manager.createSkill('test-skill', 'A test skill', '## Usage\n\nDo something.', TMP_DIR);

      // Verify file was created
      const skillMdPath = path.join(TMP_DIR, 'test-skill', 'SKILL.md');
      const content = await fs.readFile(skillMdPath, 'utf-8');
      expect(content).toContain('name: "test-skill"');
      expect(content).toContain('description: "A test skill"');
      expect(content).toContain('## Usage');
    });

    it('registers the skill so allSkills() returns it', async () => {
      await manager.createSkill('alpha', 'Alpha skill', '# Alpha', TMP_DIR);

      const skills = manager.allSkills();
      const found = skills.find(s => s.name() === 'alpha');
      expect(found).toBeTruthy();
      expect(found!.description()).toBe('Alpha skill');
    });

    it('makes getSkill() find the created skill', async () => {
      await manager.createSkill('beta', 'Beta skill', '# Beta', TMP_DIR);

      const skill = manager.getSkill('beta');
      expect(skill).toBeTruthy();
      expect(skill!.description()).toBe('Beta skill');
    });

  });

  describe('updateSkill', () => {

    it('updates the SKILL.md content on disk', async () => {
      await manager.createSkill('updatable', 'Original', '# Original', TMP_DIR);
      await manager.updateSkill('updatable', 'Updated desc', '## Updated');

      const skillMdPath = path.join(TMP_DIR, 'updatable', 'SKILL.md');
      const content = await fs.readFile(skillMdPath, 'utf-8');
      expect(content).toContain('description: "Updated desc"');
      expect(content).toContain('## Updated');
    });

    it('re-registers the skill so queries return new data', async () => {
      await manager.createSkill('reloadable', 'Old', '# Old', TMP_DIR);
      await manager.updateSkill('reloadable', 'New desc', '# New');

      const skill = manager.getSkill('reloadable')!;
      expect(skill.description()).toBe('New desc');
      expect(skill.body()).toBe('# New');
    });

  });

  describe('deleteSkill', () => {

    it('removes the skill directory from disk', async () => {
      await manager.createSkill('delete-me', 'To delete', '# Gone', TMP_DIR);
      await manager.deleteSkill('delete-me');

      const skillDir = path.join(TMP_DIR, 'delete-me');
      await expect(fs.access(skillDir)).rejects.toThrow();
    });

    it('unregisters the skill from the manager', async () => {
      await manager.createSkill('unregister-me', 'Unregister', '# Bye', TMP_DIR);
      await manager.deleteSkill('unregister-me');

      expect(manager.getSkill('unregister-me')).toBeUndefined();
      expect(manager.allSkills().find(s => s.name() === 'unregister-me')).toBeUndefined();
    });

  });

  describe('toggleSkill / isEnabled', () => {

    it('starts enabled by default', async () => {
      await manager.createSkill('enabled-default', 'Default enabled', '# Hi', TMP_DIR);
      expect(manager.isEnabled('enabled-default')).toBe(true);
    });

    it('disables a skill and persists the state', async () => {
      await manager.createSkill('toggle-me', 'Toggle', '# Toggle', TMP_DIR);
      await manager.toggleSkill('toggle-me', false);
      expect(manager.isEnabled('toggle-me')).toBe(false);
    });

    it('re-enables a disabled skill', async () => {
      await manager.createSkill('re-enable', 'Re-enable', '# Re', TMP_DIR);
      await manager.toggleSkill('re-enable', false);
      expect(manager.isEnabled('re-enable')).toBe(false);
      await manager.toggleSkill('re-enable', true);
      expect(manager.isEnabled('re-enable')).toBe(true);
    });

    it('allSkills respects enabled filter', async () => {
      await manager.createSkill('enabled-skill', 'Enabled', '# E1', TMP_DIR);
      await manager.createSkill('disabled-skill', 'Disabled', '# D1', TMP_DIR);
      await manager.toggleSkill('disabled-skill', false);

      const all = manager.allSkills();
      expect(all.length).toBeGreaterThanOrEqual(2);

      const enabledOnly = manager.allEnabledSkills();
      const enabledNames = enabledOnly.map(s => s.name());
      expect(enabledNames).toContain('enabled-skill');
      expect(enabledNames).not.toContain('disabled-skill');
    });

    it('persists disabled state across reload', async () => {
      await manager.createSkill('persist-me', 'Persist', '# Persist', TMP_DIR);
      await manager.toggleSkill('persist-me', false);

      // Reload from disk
      await manager.reloadAll();
      expect(manager.isEnabled('persist-me')).toBe(false);
    });

  });

});
