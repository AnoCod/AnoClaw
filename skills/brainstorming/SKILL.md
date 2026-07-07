---
name: brainstorming
description: "Explore user intent, requirements, and design approaches before implementation. Use for creative work, features, UI, or any task with multiple possible approaches."
triggers:
  - "create"
  - "design"
  - "new feature"
  - "how should I"
  - "what's the best way"
  - "brainstorm"
  - "idea"
when_to_use: "Before building anything new. Especially: UI/UX work, multi-file features, architectural decisions, or when the user describes a goal but not a solution."
---

# Brainstorming

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Turn ideas into fully formed designs through natural collaborative dialogue.

## The Process

### 1. Understand the Goal

- What is the user trying to accomplish? Not "what do they want built" - what OUTCOME?
- What's the current state? What's wrong with it?
- What constraints exist? Tech stack, time, compatibility requirements?

### 2. Explore Approaches

- Propose 2-3 different ways to solve it, with trade-offs.
- Lead with your recommendation and why.
- Don't settle on the first idea. The second and third are usually better.

### 3. Present the Design

For each section:
- **Architecture**: What components? How do they connect?
- **Data flow**: What goes in, what comes out, what state changes?
- **Error handling**: What can go wrong, and how is it handled?
- **Files touched**: Exact file paths that will change.

### 4. Get Approval

- Present one section at a time. Ask "Does this look right?"
- Be ready to go back and clarify.
- Don't start coding until the design is approved.

## Anti-Patterns

- "This is too simple to need design" - everything needs at least a mental plan
- Jumping to implementation mid-brainstorm
- One approach only - always explore alternatives
- Over-designing - YAGNI ruthlessly

## Design for Clarity

- Each component has ONE clear responsibility
- Well-defined interfaces between components
- Can someone understand what a component does without reading its internals?
