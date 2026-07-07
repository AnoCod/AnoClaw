---
name: systematic-debugging
description: "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes. Systematic 5-step debugging: reproduce, isolate, root cause, fix, verify."
triggers:
  - "bug"
  - "broken"
  - "error"
  - "crash"
  - "not working"
  - "failed"
  - "fix this"
  - "why is"
  - "doesn't work"
when_to_use: "When anything is broken. Before proposing ANY fix, run through this process."
---

# Systematic Debugging

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Stop. Before proposing a fix, go through these 5 steps. Every time.

## Step 1: Reproduce

- Can you see the bug yourself? Read logs, run the failing command, open the page.
- If you can't reproduce it, ask the user for exact steps.
- Do NOT guess what's wrong without seeing the error first.

## Step 2: Isolate

- Find the boundary: what's the last component that works and the first that doesn't?
- Check recent changes - 90% of bugs come from the last thing changed.
- Isolate to one file, one function, one line if possible.

## Step 3: Root Cause

- WHY does this happen? Not "what happens" - WHY.
- Trace the full logic chain. Don't stop at the symptom.
- If you have multiple theories, eliminate them one by one.

## Step 4: Fix

- Minimum change to fix the root cause. Nothing else.
- Don't refactor. Don't clean up. Don't add features. Just fix.
- If the fix is fragile, say so.

## Step 5: Verify

- Did the fix actually work? Test it.
- Did it break anything else? Check consumers.
- Report: what was the root cause, what did you change, how did you verify.

## Anti-Patterns

- "Let me try this random thing" - that's guessing, not debugging
- "I'll rewrite this whole function" - you don't understand the bug
- "It works on my machine" - then why doesn't it work on theirs?
- Skipping step 1 - you can't fix what you haven't seen
