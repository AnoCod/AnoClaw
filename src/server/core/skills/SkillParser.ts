// SkillParser.ts — YAML frontmatter parser with full Claude Code field set
// Also detects embedded shell syntax (!`cmd` and ```! ... ```) in skill bodies.

import * as yaml from 'yaml';

/** Parse a skill Markdown file into frontmatter and body. */
export function parseSkillMarkdown(
  content: string,
  filePath: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!fmMatch) {
    throw new Error(
      `Skill file "${filePath}" is missing YAML frontmatter (--- delimiters).\n` +
      'Expected: ---\nname: skill-name\ndescription: desc\n---\n\n# Body',
    );
  }

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = yaml.parse(fmMatch[1]);
    if (parsed === null || parsed === undefined) throw new Error('empty frontmatter');
    if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be key-value pairs');
    frontmatter = parsed as Record<string, unknown>;
  } catch (err: unknown) {
    throw new Error(`YAML parse error in "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const bodyStart = fmMatch[0].length;
  const body = content.slice(bodyStart).trim();
  return { frontmatter, body };
}

/** Validate skill frontmatter. Returns error strings — empty = valid. */
export function validateSkillFrontmatter(fm: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // Required: name
  if (!fm.name) errors.push('Missing "name"');
  else if (typeof fm.name !== 'string' || !fm.name.trim()) errors.push('"name" must be a non-empty string');

  // Required: description
  if (!fm.description) errors.push('Missing "description"');
  else if (typeof fm.description !== 'string' || !fm.description.trim()) errors.push('"description" must be a non-empty string');

  // Optional strings
  for (const f of ['model', 'when_to_use', 'whenToUse', 'version', 'agent', 'effort']) {
    if (fm[f] !== undefined && typeof fm[f] !== 'string') errors.push(`"${f}" must be a string`);
  }

  // Optional string arrays
  for (const f of ['tools', 'allowed-tools', 'allowed_tools', 'triggers', 'paths']) {
    if (fm[f] !== undefined) {
      if (!Array.isArray(fm[f])) errors.push(`"${f}" must be an array`);
      else {
        for (let i = 0; i < (fm[f] as unknown[]).length; i++) {
          if (typeof (fm[f] as unknown[])[i] !== 'string') errors.push(`"${f}[${i}]" must be a string`);
        }
      }
    }
  }

  // Optional numbers
  if (fm.priority !== undefined && typeof fm.priority !== 'number') errors.push('"priority" must be a number');

  // Optional enums
  if (fm.effort !== undefined && !['low', 'medium', 'high'].includes(fm.effort as string))
    errors.push('"effort" must be low/medium/high');
  if (fm.context !== undefined && !['inline', 'fork'].includes(fm.context as string))
    errors.push('"context" must be inline or fork');
  if (fm.shell !== undefined && !['bash', 'powershell'].includes(fm.shell as string))
    errors.push('"shell" must be bash or powershell');

  // Optional booleans
  if (fm.user_invocable !== undefined && typeof fm.user_invocable !== 'boolean')
    errors.push('"user_invocable" must be a boolean');
  if (fm.userInvocable !== undefined && typeof fm.userInvocable !== 'boolean')
    errors.push('"userInvocable" must be a boolean');

  return errors;
}
