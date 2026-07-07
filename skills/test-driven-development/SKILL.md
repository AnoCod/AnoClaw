---
name: test-driven-development
description: "Use when implementing any feature or bugfix, before writing implementation code. Write the failing test first, then minimal code to pass, then refactor."
triggers:
  - "implement"
  - "feature"
  - "write code"
  - "add function"
  - "create class"
  - "build"
when_to_use: "When adding new functionality or fixing bugs in code that has test infrastructure. Not for docs, config, or one-off scripts."
---

# Test-Driven Development

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

## The Cycle

```
🔴 RED -> 🟢 GREEN -> 🔵 REFACTOR -> repeat
```

### 1. RED - Write the failing test FIRST

- What should the code do? Write the test that proves it does that.
- Run it. It should FAIL. If it passes before you wrote code, your test is wrong.
- One test at a time. Don't write 10 tests then implement.

### 2. GREEN - Write minimal code to pass

- Write ONLY the code needed to make the test pass.
- The dumbest correct implementation is the right one at this stage.
- Restate the problem in a solvable way. If a direct implementation is simple, do it directly.

### 3. REFACTOR - Clean up if needed

- Now that tests pass, can you make the code cleaner without changing behavior?
- Extract repeated patterns. Improve names.
- Tests protect you during refactoring - that's the point.

## Test Structure

```ts
describe('ThingUnderTest', () => {
  it('should do the expected thing', () => {
    // Arrange - set up the test data
    const input = ...;
    
    // Act - call the function
    const result = functionUnderTest(input);
    
    // Assert - check it did the right thing
    expect(result).toBe(expectedValue);
  });
});
```

- One `describe` per function/method
- One `it` per behavior
- Test the behavior, not the implementation
- Use `__tests__/Xxx.test.ts` next to the module

## What to Test

| Priority | Type | Example |
|----------|------|---------|
| Always | Happy path | Normal input returns correct output |
| Always | Error cases | null input, empty string, out of bounds |
| Often | Edge cases | 0, -1, MAX_VALUE, empty array |
| Sometimes | State transitions | Open -> Closed, Active -> Destroyed |

## Don't Test

- Third-party library behavior - you don't own it
- Trivial getters/setters - the compiler tests those
- Implementation details - test WHAT, not HOW
