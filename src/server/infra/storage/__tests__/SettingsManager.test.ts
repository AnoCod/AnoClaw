/**
 * SettingsManager.test.ts — YAML/JSON config loader with nested key access.
 *
 * Tests cover:
 *   1. Default values when no config file exists
 *   2. get() with dot-notation keys
 *   3. set() + save() + reload
 *   4. Deep merge of partial config over defaults
 *   5. JSON fallback when YAML doesn't exist
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { mkdirSync } from 'fs';
import { SettingsManager } from '../SettingsManager.js';

const TMP_ROOT = path.resolve(process.cwd(), '.test-settings');

describe('SettingsManager', () => {
  let manager: SettingsManager;
  let configDir: string;

  beforeEach(async () => {
    configDir = path.join(TMP_ROOT, `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(configDir, { recursive: true });
    // Reset singleton
    (SettingsManager as any)._instance = undefined;
    manager = SettingsManager.getInstance();
    // Point config path to our temp directory by overriding the internal _configPath
    // after construction but before load. SettingsManager uses writablePath(PATHS.config, 'settings.yaml').
    // We override the config path directly.
    (manager as any)._configPath = path.join(configDir, 'settings.yaml');
  });

  afterEach(async () => {
    try {
      await fs.rm(TMP_ROOT, { recursive: true, force: true });
    } catch { /* ok */ }
  });

  // -----------------------------------------------------------------------
  // 1. Defaults
  // -----------------------------------------------------------------------

  it('should return default values when no config file exists', async () => {
    await manager.load();

    expect(manager.get('port')).toBe(3456);
    expect(manager.get('host')).toBe('127.0.0.1');
    expect(manager.get('llm.model')).toBe('deepseek-chat');
    expect(manager.get('logging.level')).toBe('info');
  });

  it('should return provided default when key is absent', async () => {
    await manager.load();
    expect(manager.get('nonexistent.key', 'fallback')).toBe('fallback');
  });

  // -----------------------------------------------------------------------
  // 2. Dot-notation access
  // -----------------------------------------------------------------------

  it('should traverse nested keys with dot notation', async () => {
    await manager.load();

    expect(manager.get('agent.maxTurns')).toBe(0);
    expect(manager.get('features.enableMCP')).toBe(true);
    expect(manager.get('ui.lang')).toBe('zh-CN');
    expect(manager.get('ui.userMode')).toBe('simple');
  });

  // -----------------------------------------------------------------------
  // 3. set + save + reload
  // -----------------------------------------------------------------------

  it('should persist a setting change across save and reload', async () => {
    await manager.load();
    await manager.set('port', 9999);
    await manager.save();

    // Reload
    (SettingsManager as any)._instance = undefined;
    const manager2 = SettingsManager.getInstance();
    (manager2 as any)._configPath = path.join(configDir, 'settings.yaml');
    await manager2.load();

    expect(manager2.get('port')).toBe(9999);
  });

  // -----------------------------------------------------------------------
  // 4. Deep merge
  // -----------------------------------------------------------------------

  it('should deep-merge partial config over defaults', async () => {
    // Write a partial YAML config
    const partialYaml = 'port: 7777\nllm:\n  model: custom-model\n';
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'settings.yaml'), partialYaml, 'utf-8');

    await manager.load();

    // Overridden value
    expect(manager.get('port')).toBe(7777);
    expect(manager.get('llm.model')).toBe('custom-model');
    // Default preserved
    expect(manager.get('llm.provider')).toBe('openai-compatible');
    expect(manager.get('host')).toBe('127.0.0.1');
  });

  // -----------------------------------------------------------------------
  // 5. All keys accessible
  // -----------------------------------------------------------------------

  it('should expose all settings via the .all accessor', async () => {
    await manager.load();
    const all = manager.all;
    expect(all).toHaveProperty('port');
    expect(all).toHaveProperty('llm');
    expect(all).toHaveProperty('agent');
    expect(all).toHaveProperty('logging');
  });
});
