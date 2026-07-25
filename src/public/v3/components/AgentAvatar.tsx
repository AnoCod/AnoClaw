import { useState } from 'preact/hooks';
import type { Agent } from '../model.js';

const FALLBACK = '/assets/v3/agents/mainagent.png';
type AvatarAgent = Pick<Agent, 'name' | 'capabilities'>;

export function AgentAvatar({
  agent,
  size = 'medium',
  priority = false,
}: {
  agent?: AvatarAgent;
  size?: 'small' | 'medium' | 'large';
  priority?: boolean;
}) {
  const [source, setSource] = useState(() => avatarSource(agent));
  const label = agent?.name ?? 'MainAgent';

  return (
    <img
      class={`agent-avatar agent-avatar--${size}`}
      src={source}
      alt={label}
      width={size === 'large' ? 96 : size === 'medium' ? 52 : 38}
      height={size === 'large' ? 96 : size === 'medium' ? 52 : 38}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => {
        if (source !== FALLBACK) setSource(FALLBACK);
      }}
    />
  );
}

function avatarSource(agent?: AvatarAgent): string {
  if (!agent) return FALLBACK;
  const capabilities = agent.capabilities.map((capability) =>
    capability.toLowerCase().replace(/[\s_]+/g, '-')
  );
  if (
    capabilities.some((capability) =>
      capability.includes('designer')
      || capability.includes('design')
      || capability.includes('product')
      || capability.includes('产品设计')
    )
  ) {
    return '/assets/v3/agents/product-designer.png';
  }
  if (
    capabilities.some((capability) =>
      capability.includes('operations')
      || capability.includes('manager')
      || capability.includes('project')
      || capability.includes('coordination')
      || capability.includes('运营')
      || capability.includes('协调')
    )
  ) {
    return '/assets/v3/agents/operations-manager.png';
  }
  if (
    capabilities.some((capability) =>
      capability.includes('strategy')
      || capability.includes('planning')
      || capability.includes('lead')
      || capability.includes('规划')
    )
  ) {
    return '/assets/v3/agents/strategy-lead.png';
  }
  if (
    capabilities.some((capability) =>
      capability.includes('data-analyst') || capability.includes('data-analysis')
    )
  ) {
    return '/assets/v3/agents/data-analyst.png';
  }
  if (
    capabilities.some((capability) =>
      capability.includes('research-analyst') || capability.includes('research')
    )
  ) {
    return '/assets/v3/agents/research-analyst.png';
  }
  return FALLBACK;
}
