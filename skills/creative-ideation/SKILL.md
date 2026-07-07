---
name: creative-ideation
description: "Generate creative project ideas through constraint-driven brainstorming. Use when the user wants project inspiration, feels stuck, says \"give me ideas\", or wants to build something but doesn't know what."
when_to_use: "User is bored, out of ideas, or wants creative inspiration for projects across any domain - code, art, writing, hardware, business, content creation."
triggers:
  - "idea"
  - "inspiration"
  - "bored"
  - "what should I build"
  - "give me a project"
  - "brainstorm"
  - "what can I make"
---

# Creative Ideation

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Generate project ideas through creative constraints. Constraint + direction = creativity.

## When to Use

User says 'I want to build something', 'give me a project idea', 'I'm bored', 'what should I make', 'inspire me', or any variant of 'I have tools but no direction'. Works for code, art, hardware, writing, business, and anything that can be made.

## How It Works

1. **Pick a constraint** - random, or matched to the user's domain/mood
2. **Interpret it broadly** - a coding prompt can become hardware, an art prompt can become a CLI tool
3. **Generate 3 concrete project ideas** that satisfy the constraint
4. **If they pick one, build it** - create the project, write the code, ship it

## Constraint Library

### Technical
- "Must work offline completely"
- "Must fit in a single file under 500 lines"
- "Must use only standard library / built-in tools"
- "Must support real-time collaboration"
- "Must run on a Raspberry Pi"

### Creative
- "Must tell a story"
- "Must make something invisible visible"
- "Must use only 3 colors"
- "Must work in complete darkness"
- "Must respond to sound"

### Business
- "Must generate revenue in week one"
- "Must require zero user accounts"
- "Must serve exactly 100 users perfectly"
- "Must replace a spreadsheet someone uses daily"

### Constraint Combos (pick 2-3)
Mix technical + creative + business constraints for truly unique ideas.

## Output Format

For each idea:
1. **Project name** (catchy, 2-4 words)
2. **One-line pitch**
3. **Why this constraint makes it interesting**
4. **What you'd need** (tools, skills, time)
5. **First step** (what to do right now to start)
