---
name: simplify
description: "Review code for reuse, simplification, and efficiency improvements. Quality-focused - does NOT hunt for bugs. Apply findings directly."
triggers:
  - "simplify"
  - "clean up"
  - "refactor"
  - "too complex"
  - "can this be simpler"
  - "DRY"
when_to_use: "When code works but is too complex. When you see 3+ similar blocks. When a function is too long. NOT for bug fixing - that's systematic-debugging."
---

# Simplify

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Quality improvements only. No bug hunting. Apply findings directly.

## What to Look For

### Reuse Opportunities

- Is there existing code that does the same thing?
- Are 3+ blocks nearly identical? Extract the common pattern.
- Is someone reinventing a built-in? Array methods, string methods, path.join.

### Simplification

- Can this be fewer lines without losing clarity?
- Can you remove an abstraction layer that isn't pulling its weight?
- Are there unnecessary conditionals? Early returns are cleaner than deep nesting.
- Can you replace a loop with map/filter/reduce?

### Efficiency

- Redundant file reads? Cache them.
- Redundant API calls? Batch or memoize.
- Expensive work in hot loops? Move outside.
- Unnecessary async/await on synchronous operations?

### Altitude

- Is this the right level of abstraction?
- Is this code in the right file? Or should it be in a different module?
- Does this function do ONE thing? If it has "and" in its name, split it.

## What NOT to Do

- Don't hunt for bugs - that's systematic-debugging / code-review
- Don't add features - that's scope creep
- Don't restructure working code that isn't obviously messy
- Don't add comments to explain bad code - fix the code instead

## Apply Immediately

When you find something to simplify, apply the change. Don't just report it. One simplification at a time, verify it still works, move on.
