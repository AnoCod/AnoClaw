/**
 * Shared color utilities for status/role/node-type color mapping.
 * Centralizes color definitions that were previously scattered across TS files.
 * For DOM elements, prefer CSS classes with var(--color-*) tokens.
 * This utility is for contexts where CSS vars can't be used directly (canvas, programmatic coloring).
 */

/** Read a CSS custom property value from the document root */
export function getCSSVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Status color map — use CSS var() for DOM, getCSSVar() for canvas contexts */
export const STATUS_COLORS: Record<string, string> = {
  idle: 'var(--color-text-quaternary)',
  queued: 'var(--color-warning)',
  running: 'var(--color-info)',
  success: 'var(--color-success)',
  completed: 'var(--color-success)',
  error: 'var(--color-error)',
};

/** Resolve a status color to a concrete hex value (for canvas 2D contexts) */
export function resolveStatusColor(status: string): string {
  const cssVar = STATUS_COLORS[status] || STATUS_COLORS.idle;
  const match = cssVar.match(/var\(--(.+?)\)/);
  if (match) return getCSSVar(`--${match[1]}`);
  return cssVar;
}

/** Agent role color palette — design-system-aligned, not semantic tokens */
export const ROLE_COLORS: Record<string, string> = {
  ceo: '#ff6161',
  manager: '#57c1ff',
  member: '#59d499',
  default: '#6a6b6c',
};

/** Resolve a role prefix to a color (checks against ROLE_COLORS keys) */
export function resolveRoleColor(rolePrefix: string): string {
  for (const [key, color] of Object.entries(ROLE_COLORS)) {
    if (rolePrefix.startsWith(key)) return color;
  }
  return ROLE_COLORS.default;
}
