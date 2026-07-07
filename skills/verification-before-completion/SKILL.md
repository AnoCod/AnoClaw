---
name: verification-before-completion
description: "Verify work actually works before claiming it's done. Run tests, check outputs, confirm behavior. Evidence before assertions, always."
triggers:
  - "done"
  - "finished"
  - "complete"
  - "ready"
  - "verify"
  - "check this"
  - "does this work"
when_to_use: "Before reporting ANY task as complete. Before committing. Before telling the user 'it's fixed'. Every single time."
---

# Verification Before Completion

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Never claim something is done without proving it.

## The Check

Before saying "done", ask yourself:

1. **Did I run the code?** Not just compile. Run it. See the output.
2. **Did I test the actual fix?** Not "the code looks right." Execute it.
3. **Did I check for regressions?** Run related tests. Check consumers.
4. **Did I verify the user's scenario?** Do what they would do. See what they would see.

## What to Run

| What you changed | Verification |
|-----------------|-------------|
| Server code | `npm run build:all` must pass, no new errors |
| Server code (logic) | Run relevant `__tests__/` files |
| Frontend code | Open the page, check F12 Console for errors |
| Prompt / Tool | Send a message through the chat, see if agent responds correctly |
| Packaging | User double-clicks `AnoClaw.exe`, setup wizard works |

## If You Can't Verify

Say so explicitly. Examples:
- "Builds clean but I can't test the UI - no browser available."
- "The logic looks correct but the relevant test file doesn't exist."
- "I've changed the prompt section but need you to test if agent behavior improved."

## Anti-Patterns

- "It should work" - that's not verification, that's hope
- "The code looks correct" - looking is not testing
- "I compiled it" - compiling is not running
- "It worked last time" - things change

## The Rule

**No evidence = not done.** Show me the test passing, the page loading, the error gone. Or tell me honestly you can't verify and why.
