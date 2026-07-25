import type { JSX } from 'preact';

const ICONS = {
  work: 'chat.svg',
  company: 'agents.svg',
  settings: 'settings.svg',
  close: 'close.svg',
  maximize: 'overview.svg',
  minimize: 'pause.svg',
  check: 'check.svg',
  active: 'circle-filled.svg',
  idle: 'circle-outline.svg',
  send: 'mode-auto.svg',
  document: 'plan.svg',
  folder: 'folder.svg',
  timer: 'timer.svg',
  collapse: 'mode-plan.svg',
  overview: 'overview.svg',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 18,
  class: className,
}: {
  name: IconName;
  size?: number;
  class?: string;
}) {
  return (
    <span
      class={`v3-icon ${className ?? ''}`}
      aria-hidden="true"
      style={{
        '--v3-icon': `url("/icons/${ICONS[name]}")`,
        width: `${size}px`,
        height: `${size}px`,
      } as JSX.CSSProperties}
    />
  );
}
