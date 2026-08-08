import { describe, expect, it } from 'vitest';
import type { EcosystemAsset } from '../types.js';
import { parseSkillAsset } from '../importers/skill-importer.js';

function skillAsset(content: string, name = 'test-skill', kind: 'claude' | 'openclaw' | 'codex' | 'hermes' | 'opencode' = 'claude'): EcosystemAsset {
  return {
    kind,
    assetType: 'skill',
    name,
    displayName: name,
    sourcePath: `/tmp/${name}/SKILL.md`,
    supportLevel: 'native',
    payload: { content, skillDir: `/tmp/${name}` },
  };
}

describe('parseSkillAsset', () => {
  it('parses standard Claude-style frontmatter and preserves unknown fields', () => {
    const asset = skillAsset(`---
name: api-testing
description: Test APIs
allowed-tools:
  - Bash
version: 1.0.0
custom-field: keep-me
---

# Usage
Do things.
`);
    const { skill } = parseSkillAsset(asset);
    expect(skill.name()).toBe('api-testing');
    expect(skill.requiredTools()).toEqual(['Bash']);
    expect(skill.rawFrontmatter()['custom-field']).toBe('keep-me');
    expect(skill.origin()).toMatchObject({ kind: 'claude', supportLevel: 'native' });
  });

  it('parses OpenClaw metadata JSON into an object', () => {
    const asset = skillAsset(`---
name: image-lab
description: Generate images
metadata: {"openclaw":{"requires":{"bins":["uv"]}}}
---

Body
`, 'image-lab', 'openclaw');
    const { skill } = parseSkillAsset(asset);
    expect(skill.name()).toBe('image-lab');
    const metadata = skill.rawFrontmatter().metadata as Record<string, unknown>;
    expect((metadata.openclaw as Record<string, unknown>).requires).toBeTruthy();
  });

  it('falls back to OpenClaw single-line frontmatter when YAML is invalid', () => {
    const asset = skillAsset(`---
name: image-lab
description: [unclosed
---

Body
`, 'image-lab', 'openclaw');
    const { skill, warnings } = parseSkillAsset(asset);
    expect(skill.name()).toBe('image-lab');
    expect(warnings.some((w) => w.includes('fallback'))).toBe(true);
  });

  it('renames skills when a mount name is provided', () => {
    const asset = skillAsset(`---
name: pdf-tools
description: PDF tools
---

Body
`);
    const { skill, warnings } = parseSkillAsset(asset, 'codex:pdf-tools');
    expect(skill.name()).toBe('codex:pdf-tools');
    expect(warnings.some((w) => w.includes('Renamed'))).toBe(true);
  });

  it('substitutes skill-dir path variables in the body', () => {
    const asset = skillAsset(`---
name: paths
description: Path vars
---

Run ${'${CLAUDE_SKILL_DIR}'}/script.py
    `, 'paths');
    const { skill } = parseSkillAsset(asset);
    expect(skill.body()).toMatch(/[\\/]tmp[\\/]paths[\\/]script\.py/);
  });
});
