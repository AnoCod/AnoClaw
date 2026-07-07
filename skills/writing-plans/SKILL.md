---
name: writing-plans
description: "Create detailed implementation plans from specs or requirements. Each step is 2-5 minutes of work. Use for multi-step tasks before touching code."
triggers:
  - "plan"
  - "write a plan"
  - "implementation plan"
  - "how to implement"
  - "break down"
  - "roadmap"
when_to_use: "When you have a spec or design and need to turn it into bite-sized implementation steps. Use whenever the task spans 3+ files or 2+ distinct phases."
---

# Writing Implementation Plans

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Turn a design spec into executable, bite-sized tasks.

## Plan Structure

```markdown
# [Feature Name] Implementation Plan

**Goal:** One sentence.

**Architecture:** 2-3 sentences about approach.

**Tech Stack:** Key technologies.

---

### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts:123-145`

- [ ] **Step 1: Write the failing test**
[actual test code here]

- [ ] **Step 2: Run test to verify it fails**
Run: `command here`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**
[actual implementation code here]

- [ ] **Step 4: Run test to verify it passes**
Run: `command here`
Expected: PASS
```

## Task Granularity

Each step = one action (2-5 minutes):
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to pass" - step
- "Run the tests and make sure they pass" - step

## Rules

1. **Exact file paths always.** Never "the handler file" - write `src/server/gateway/handlers/SessionHandlers.ts:420`
2. **Complete code in every step.** If a step changes code, show the code. Don't say "add error handling."
3. **Exact commands with expected output.** Not "run the tests" - `npx vitest run src/server/core/__tests__/foo.test.ts`
4. **No placeholders.** Never write "TBD", "TODO", "implement later", "add validation".
5. **Type first, then code.** If you're changing shared types, do that first as a separate task, build, then change consumers.

## After Writing

Self-review:
1. Does every spec requirement trace to a task?
2. Are there any placeholders? Fix them.
3. Do method names and types stay consistent across tasks?
