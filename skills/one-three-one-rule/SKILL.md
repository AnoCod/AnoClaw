---
name: one-three-one-rule
description: "Structured decision-making framework for proposals and trade-off analysis. Use when facing a choice between multiple approaches - produces a 1-3-1 format: one problem, three options with pros/cons, one recommendation."
when_to_use: "User faces a decision between multiple approaches, asks for options, needs a proposal, or says 'what should I choose'."
triggers:
  - "1-3-1"
  - "options"
  - "choices"
  - "trade-off"
  - "which approach"
  - "pros and cons"
  - "recommendation"
---

# 1-3-1 Communication Rule

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Structured decision-making format for when a task has multiple viable approaches and needs a clear recommendation.

## When to Use

- User says "give me options" or "what are my choices"
- A task has multiple viable approaches with meaningful trade-offs
- The user needs a proposal they can show to others
- Architecture decisions, tool selection, migration strategies

## The Format

### 1 - One Clear Problem Statement

What decision needs to be made? Why now? What are the constraints?

### 3 - Three Distinct Options

For each option:
- **Approach**: What we'd do (2-3 sentences)
- **Pros**: What makes this option good (3-5 bullets)
- **Cons**: What makes this option risky (3-5 bullets)
- **Effort**: Low / Medium / High
- **Risk**: Low / Medium / High

Options must be genuinely different - not variations of the same idea.

### 1 - One Concrete Recommendation

- **My recommendation**: Which option and why
- **Definition of done**: How we know we succeeded
- **Next step**: The very first action to take

## Anti-Patterns

- All three options are the same idea with different names
- Recommending without explaining why the others lost
- Missing the "definition of done" - vague success criteria
- Analysis paralysis - if options are close, pick one and move
