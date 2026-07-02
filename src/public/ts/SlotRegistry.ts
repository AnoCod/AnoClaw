// SlotRegistry.ts — Tracks which plugin owns which slot content.
// When a plugin is deactivated, its slot content is automatically cleaned up.

type SlotPosition = 'append' | 'prepend';

interface SlotEntry {
  element: HTMLElement;
  pluginName: string;
}

class SlotRegistry {
  private _entries = new Map<string, SlotEntry[]>();
  private _pending = new Map<string, Array<{ el: HTMLElement; opts?: { position?: SlotPosition; replace?: boolean } }>>();

  mount(slot: string, el: HTMLElement, position?: string, replace?: boolean, pluginName: string = 'unknown'): void {
    const opts = position ? { position: position as SlotPosition, replace } : undefined;
    const target = document.querySelector(`[data-slot="${slot}"]`);
    if (!target) {
      console.debug(`[Slot] "${slot}" not in DOM yet — queued (plugin: ${pluginName})`);
      if (!this._pending.has(slot)) this._pending.set(slot, []);
      this._pending.get(slot)!.push({ el, opts });
      return;
    }
    console.log(`[Slot] mount → "${slot}" position=${position || 'append'} replace=${replace || false} plugin=${pluginName}`);
    this._doMount(target, slot, el, opts);
    if (!this._entries.has(slot)) this._entries.set(slot, []);
    this._entries.get(slot)!.push({ element: el, pluginName });
  }

  private _doMount(target: Element, _slot: string, el: HTMLElement, opts?: { position?: SlotPosition; replace?: boolean }): void {
    if (opts?.replace) { target.innerHTML = ''; }
    if (opts?.position === 'prepend') { target.prepend(el); }
    else { target.appendChild(el); }
  }

  unmount(_slot: string, el: HTMLElement): void {
    console.log(`[Slot] unmount element from "${_slot}"`);
    if (el.parentElement) el.remove();
    for (const [, entries] of this._entries) {
      const idx = entries.findIndex(e => e.element === el);
      if (idx >= 0) { entries.splice(idx, 1); return; }
    }
  }

  unmountAll(slot: string): void {
    const entries = this._entries.get(slot);
    console.log(`[Slot] unmountAll "${slot}" — ${entries ? entries.length : 0} entries`);
    if (entries) {
      for (const { element } of entries) { if (element.parentElement) element.remove(); }
      this._entries.delete(slot);
    }
  }

  _onSlotReady(slot: string): void {
    const pending = this._pending.get(slot);
    if (!pending) return;
    this._pending.delete(slot);
    console.log(`[Slot] "${slot}" DOM ready — draining ${pending.length} queued mounts`);
    const target = document.querySelector(`[data-slot="${slot}"]`);
    if (!target) { console.warn(`[Slot] "${slot}" still not in DOM after ready signal`); return; }
    for (const { el, opts } of pending) {
      this._doMount(target, slot, el, opts);
    }
  }

  removeByPlugin(pluginName: string): void {
    console.log(`[Slot] removeByPlugin "${pluginName}"`);
    for (const [slot, entries] of this._entries) {
      for (const entry of entries) {
        if (entry.pluginName === pluginName) {
          if (entry.element.parentElement) entry.element.remove();
        }
      }
      const filtered = entries.filter(e => e.pluginName !== pluginName);
      if (filtered.length === 0) this._entries.delete(slot);
      else this._entries.set(slot, filtered);
    }
    for (const [slot, pending] of this._pending) {
      this._pending.delete(slot);
    }
  }
}

export const slotRegistry = new SlotRegistry();
