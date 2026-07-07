// anoclaw-api.ts — Main-thread window.anoclaw setup.

import { uiRegistry } from './UIComponentRegistry.js';
import { slotRegistry } from './SlotRegistry.js';
import { toolCardRegistry } from './ToolCardRegistry.js';
import { Button } from './components/ui/Button.js';
import { Dialog } from './components/ui/Dialog.js';
import { Toggle } from './components/ui/Toggle.js';
import { Card } from './components/ui/Card.js';
import { FormField } from './components/ui/FormField.js';
import { Input } from './components/ui/Input.js';
import { Select } from './components/ui/Select.js';
import { Textarea } from './components/ui/Textarea.js';
import { Badge } from './components/ui/Badge.js';
import { Tooltip } from './components/ui/Tooltip.js';
import { Toast } from './components/ui/Toast.js';
import { Tabs } from './components/ui/Tabs.js';
import { Progress } from './components/ui/Progress.js';
import { EmptyState } from './components/ui/EmptyState.js';
import { Spinner } from './components/ui/Spinner.js';
import { ContextMenu } from './components/ui/ContextMenu.js';
import { ToolCard } from './components/ui/ToolCard.js';
import { ToolCardResult } from './components/ui/ToolCardResult.js';
import { ToolCardDiff } from './components/ui/ToolCardDiff.js';
import { ToolCardProgress } from './components/ui/ToolCardProgress.js';
import { ToolCardError } from './components/ui/ToolCardError.js';
import { TodoCard } from './components/ui/TodoCard.js';
import { StatusCard } from './components/ui/StatusCard.js';
import { SystemCard } from './components/ui/SystemCard.js';
import { AskUserCard } from './components/ui/AskUserCard.js';

export function initAnoClawAPI(): void {
  const components: Record<string, unknown> = {
    Button, Dialog, Toggle, Card, FormField, Input, Select, Textarea,
    Badge, Tooltip, Toast, Tabs, Progress, EmptyState, Spinner, ContextMenu,
  };
  for (const [name, Comp] of Object.entries(components)) {
    uiRegistry.registerDefault(name, Comp);
  }
  console.log(`[AnoClaw] UI initialized — ${Object.keys(components).length} components registered`);

  // Tool card presets — map style names to card classes
  toolCardRegistry.registerPreset('default', ToolCard);
  toolCardRegistry.registerPreset('result', ToolCardResult);
  toolCardRegistry.registerPreset('diff', ToolCardDiff);
  toolCardRegistry.registerPreset('progress', ToolCardProgress);
  toolCardRegistry.registerPreset('error', ToolCardError);
  console.log('[AnoClaw] ToolCard presets registered: default, result, diff, progress, error');

  (window as any).anoclaw = {
    ui: {
      Button, Dialog, Toggle, Card, FormField, Input, Select, Textarea,
      Badge, Tooltip, Toast, Tabs, Progress, EmptyState, Spinner, ContextMenu,
      ToolCard, ToolCardResult, ToolCardDiff, ToolCardProgress, ToolCardError,
      TodoCard, StatusCard, SystemCard, AskUserCard,
      register: (name: string, comp: unknown) => uiRegistry.register(name, comp),
      unregister: (name: string) => uiRegistry.unregister(name),
      registerToolCard: (toolName: string, Component: unknown) => {
        toolCardRegistry.register(toolName, Component);
        console.log(`[AnoClaw] ToolCard override: "${toolName}"`);
      },
      unregisterToolCard: (toolName: string) => toolCardRegistry.unregister(toolName),
      mount: (
        slot: string,
        el: HTMLElement,
        positionOrOpts?: 'append' | 'prepend' | { position?: 'append' | 'prepend'; replace?: boolean; id?: string; priority?: number; pluginName?: string },
        replace?: boolean,
      ) => {
        const pluginName = typeof positionOrOpts === 'object' && positionOrOpts?.pluginName
          ? positionOrOpts.pluginName
          : (el.dataset.pluginName || 'plugin-runtime');
        slotRegistry.mount(slot, el, positionOrOpts as any, replace, pluginName);
      },
      unmount: (slot: string, el: HTMLElement) => {
        slotRegistry.unmount(slot, el);
      },
      unmountAll: (slot: string, pluginName?: string) => {
        slotRegistry.unmountAll(slot, pluginName);
      },
    },
  };
}
