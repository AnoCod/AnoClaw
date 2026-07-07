---
name: frontend-design
description: "Create distinctive, intentional UI - not templated defaults. Use for building new UI, restyling existing interfaces, or choosing visual direction."
triggers:
  - "UI"
  - "design"
  - "style"
  - "layout"
  - "look"
  - "theme"
  - "visual"
  - "beautiful"
  - "ugly"
when_to_use: "When building new user interfaces, restyling existing ones, or making visual choices. NOT for bug fixes - use systematic-debugging for broken UI."
---

# Frontend Design

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Make interfaces that don't look templated. Use AnoClaw's built-in design tokens.

## First: Pick a Brand

AnoClaw ships with 75 brand design tokens in `docs/design-md/`. 

```bash
Glob docs/design-md/*/
```

Pick one matching the feature's vibe. Read its `DESIGN.md`. Extract tokens into CSS variables. Follow spacing, rounded corners, and shadow specs exactly.

## CSS Rules (AnoClaw-Specific)

1. **CSS variables only** - `var(--color-primary)`, never `#ffffff`
2. **No `style.cssText`** - use class toggles. Inline only for x/y/w/h positioning.
3. **Dark theme first** - variables in `:root`. Light overrides via `[data-theme="light"]`.
4. **SVG icons only** - no emoji. Use inline SVG strings or `icons/` directory.
5. **Safe DOM** - `textContent` for user content, not `innerHTML`.

## Design Tokens Available

All components auto-inject `tokens.css`. These variables are ALWAYS available:
- Colors: `--color-accent`, `--color-bg`, `--color-surface`, `--color-text-primary/secondary/tertiary`
- Spacing: `--space-xs/sm/md/lg/xl/xxl`
- Radius: `--radius-xs/sm/md/lg/xl/full`
- Typography: `--font-sans`, `--font-mono`, `--font-size-*`
- Cinema variables: `--cinema-text-*`, `--cinema-bg-*`, `--hairline-cinema`

## Use the Component Library

25 components available via `anoclaw.ui.*`:
```js
// Basic: Button, Dialog, Toggle, Card, FormField, Input, Select, Textarea,
//        Badge, Tooltip, Toast, Tabs, Progress, EmptyState, Spinner, ContextMenu
// Tool cards: ToolCard, ToolCardResult, ToolCardDiff, ToolCardProgress, ToolCardError
// Special: TodoCard, StatusCard, SystemCard, AskUserCard
```

## Visual Hierarchy

1. **Most important thing first.** Users scan top-to-bottom, left-to-right.
2. **One primary action per view.** Everything else is secondary.
3. **Group related items.** Use spacing, not borders, to create visual groups.
4. **Empty states matter.** Use `EmptyState` component - icon + title + description + action.
