---
name: motion-design
description: "Create kinetic typography, animated data visualizations, and motion graphics. Use for animated text reveals, scrolling numbers, particle effects, and professional-looking motion design without After Effects."
when_to_use: "User wants animated text, kinetic typography, data animations, particle effects, or motion graphics for their project."
triggers:
  - "animation"
  - "motion"
  - "kinetic"
  - "particles"
  - "animate text"
  - "motion graphics"
  - "typography"
allowed-tools:
  - Read
  - Write
  - Bash
---

# Motion Design

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Create professional motion graphics programmatically. CSS animations for web, Remotion for video, canvas for particles.

## Animation Principles (12 Disney Rules)

1. **Squash & Stretch** - objects deform with motion
2. **Anticipation** - prepare for action (back before forward)
3. **Staging** - direct attention to what matters
4. **Follow Through** - parts keep moving after main action stops
5. **Ease In/Out** - nothing moves at constant speed
6. **Arc** - natural motion follows curved paths

## CSS Animation Quick Reference

```css
/* Fade in + slide up */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(20px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Pulse */
@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

/* Shimmer loading */
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

/* Spin */
@keyframes spin {
  to { transform: rotate(360deg); }
}
```

## Easing Functions

```
linear       -> constant speed (robotic - avoid)
ease         -> slow start, fast middle, slow end (default, good)
ease-in      -> slow start (for elements entering)
ease-out     -> slow end (for elements exiting)
cubic-bezier -> full control
```

Natural feeling: `cubic-bezier(0.4, 0, 0.2, 1)` - Google Material standard.

## Spring Physics (Remotion)

```tsx
import { spring, useCurrentFrame } from 'remotion';

const frame = useCurrentFrame();
const scale = spring({ frame, fps: 30, config: { damping: 15, stiffness: 100 } });
const fadeIn = spring({ frame, fps: 30, config: { damping: 200, stiffness: 50 } });
```

Preset configs:
- **Snappy**: `{ damping: 15, stiffness: 200 }` - buttons, toggles
- **Smooth**: `{ damping: 50, stiffness: 100 }` - page transitions
- **Bouncy**: `{ damping: 8, stiffness: 100 }` - playful elements

## Kinetic Typography Patterns

### Typewriter Reveal
```css
@keyframes typewriter {
  from { width: 0; }
  to { width: 100%; }
}
.typewriter {
  overflow: hidden;
  white-space: nowrap;
  animation: typewriter 2s steps(40) forwards;
}
```

### Word-by-Word Fade
```tsx
{words.map((word, i) => (
  <span key={i} style={{ 
    opacity: interpolate(frame, [i*5, i*5+10], [0, 1]) 
  }}>
    {word}{' '}
  </span>
))}
```

### Counting Numbers
```tsx
const value = interpolate(frame, [0, 60], [0, 1000000]);
const display = Math.round(value).toLocaleString();
```

## Particle Effects

For web: use `<canvas>` with JavaScript. For video: generate with Remotion.

Basic particle system:
```js
const particles = Array.from({ length: 100 }, () => ({
  x: Math.random() * canvas.width,
  y: Math.random() * canvas.height,
  vx: (Math.random() - 0.5) * 2,
  vy: (Math.random() - 0.5) * 2,
  size: Math.random() * 3 + 1,
}));
```

## When NOT to Use

- Simple hover effects -> CSS `:hover` is enough
- Loading spinner -> use `Spinner` component from `anoclaw.ui`
- Page transitions -> `layout-motion.css` already has `page-enter` keyframes
- The user said "just make it work" -> motion is polish, not MVP
