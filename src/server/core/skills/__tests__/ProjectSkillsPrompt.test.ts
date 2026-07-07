import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSkillMarkdown, validateSkillFrontmatter } from '../SkillParser.js';

describe('project skill prompt fixtures', () => {
  it('all project skills parse and include multi-agent handoff guidance', () => {
    const skillsDir = path.resolve(process.cwd(), 'skills');
    const skillFiles = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(skillsDir, entry.name, 'SKILL.md'))
      .filter(file => fs.existsSync(file));

    expect(skillFiles.length).toBeGreaterThan(0);

    for (const file of skillFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const parsed = parseSkillMarkdown(content, file);
      expect(validateSkillFrontmatter(parsed.frontmatter), file).toEqual([]);
      expect(parsed.body, file).toContain('## Agent Handoff');
      expect(parsed.body, file).toContain('Do not override higher-priority system, permission, or delegation rules.');
      expect(content, file).not.toMatch(/[鈥鈫鈼鉁鈿锟�]/);
    }
  });
});
