---
name: code-review
description: "Review code changes for correctness bugs, security issues, and reuse/simplification opportunities. Use before merging or when asked to review."
triggers:
  - "review"
  - "check this code"
  - "code review"
  - "audit"
  - "verify this"
when_to_use: "When reviewing any code change before it goes live. Also use when asked to check someone's code for bugs or quality."
---

# Code Review

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Read every changed line with these questions in mind.

## Correctness Bugs

- Does it do what it claims to do? Trace the logic.
- Are edge cases handled? null, empty, 0, MAX_VALUE, boundary conditions.
- Are there race conditions? What if two instances run at the same time?
- Are errors handled correctly? What if the network fails mid-operation?
- Does it match the types? Any implicit `any` casts that might hide bugs?

## Security Issues

- Is user input sanitized before going to shell/HTML/database?
- Are API keys, tokens, or passwords hardcoded?
- Are file paths validated to prevent traversal (`../../etc/passwd`)?
- Does it use `innerHTML` with user content? (XSS)

## Reuse & Simplification

- Is there existing code that does the same thing? 
- Can this be simpler with fewer lines? Fewer branches? Less abstraction?
- Is this the right level of abstraction? Not too high, not too low.
- Are there 3+ similar blocks? Extract if they share a real pattern.

## Efficiency

- Is it doing expensive work in a hot loop? Memoize or cache.
- Is it reading a file when it could read from memory?
- Is it making redundant API calls? Batch or cache.

## Review Output Format

For each finding:
1. **Severity**: Critical / High / Medium / Low
2. **Location**: file:line
3. **What's wrong**: one sentence
4. **Fix**: one sentence

End with a summary: "Found N issues (X critical, Y high, Z medium, W low)"
