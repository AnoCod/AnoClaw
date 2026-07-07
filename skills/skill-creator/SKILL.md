---
name: skill-creator
description: "Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy."
when_to_use: "User wants to create a new skill, improve an existing one, or asks about skills in general. Also when the user mentions 'skill', 'SKILL.md', 'make me a skill for X', or 'how do I teach you to do Y'."
triggers:
  - "skill"
  - "SKILL.md"
  - "create a skill"
  - "make me a skill"
  - "teach you"
  - "how do I make"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - SkillList
  - SkillInspect
  - Skill
---

# Skill Creator

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

A skill for creating new skills and iteratively improving them.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Create a few test prompts and run claude-with-access-to-the-skill on them
- Help the user evaluate the results both qualitatively and quantitatively
- Rewrite the skill based on feedback from the user's evaluation of the results
- Repeat until you're satisfied

## Skill Structure

Every skill is a directory under `skills/<name>/` with a `SKILL.md` file:

```
skill-name/
└── SKILL.md  (required - YAML frontmatter + Markdown body)
```

## Frontmatter Fields

```yaml
---
name: skill-name              # Required: kebab-case identifier
description: What this does   # Required: when to trigger, what it does
when_to_use: When to use it   # Optional: natural language description of scenarios
triggers:                     # Optional: keyword phrases that auto-trigger
  - "keyword 1"
  - "keyword 2"
allowed-tools:                # Optional: tools this skill needs
  - Read
  - Write
model: sonnet                 # Optional: model preference
effort: high                  # Optional: low/medium/high
paths:                        # Optional: file paths that auto-activate the skill
  - "src/frontend/**"
version: "1.0.0"              # Optional
---
```

## Frontmatter Best Practices

**Name**: Use kebab-case. Short and descriptive. `code-review`, not `cr`.

**Description**: The MOST important field. This controls when Claude auto-triggers the skill. Include BOTH what the skill does AND specific contexts for when to use it. Be a little "pushy" - skills tend to "undertrigger", so include trigger words and scenarios. Example:

```yaml
description: Add comprehensive logging to Python code. Use this skill whenever the user mentions logging, debugging output, print statements, log levels, or wants to see what their code is doing at runtime.
```

**Body**: Markdown instructions. Use imperative form ("Do X", not "You should do X"). Keep under 500 lines - if approaching this limit, add a README.md or reference files.

## Writing Guide

1. **Explain WHY, not just WHAT.** Instead of "Always use structured logging", say "Use structured logging so you can filter by severity when debugging in production."

2. **Avoid heavy-handed MUST/SHOULD language.** Modern LLMs respond better to reasoning than commands. Explain the principle.

3. **Keep prompts lean.** Remove things that aren't pulling their weight. If a section isn't producing better results, cut it.

4. **Look for repeated work.** If all test cases cause the agent to write the same helper script, bundle that script into the skill's directory.

## What Makes a Good Skill

- **Specific**: `debug-python-celery` is better than `debug`
- **Actionable**: The agent can immediately apply it
- **Self-contained**: Everything the agent needs is in the SKILL.md
- **Bounded**: One skill = one domain. Don't try to cover everything.

## Creating a New Skill

1. Create `skills/<name>/SKILL.md`
2. Write YAML frontmatter with name + description
3. Write Markdown body with instructions
4. Test with real prompts - does the agent behave better?
5. Iterate based on what works

To install a skill from GitHub: the skill-creator skill itself can clone a repo into `skills/` and the system auto-detects it.
