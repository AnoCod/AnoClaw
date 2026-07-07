// SlotRegistry.ts - robust named extension slots for plugins.

type SlotPosition = 'append' | 'prepend';

export interface SlotMountOptions {
  position?: SlotPosition;
  replace?: boolean;
  id?: string;
  priority?: number;
}

interface SlotEntry {
  element: HTMLElement;
  pluginName: string;
  key: string;
  priority: number;
  insertedAt: number;
}

interface PendingSlotEntry {
  el: HTMLElement;
  pluginName: string;
  key: string;
  opts: SlotMountOptions;
}

class SlotRegistry {
  private _entries = new Map<string, SlotEntry[]>();
  private _pending = new Map<string, PendingSlotEntry[]>();
  private _counter = 0;

  mount(
    slot: string,
    el: HTMLElement,
    positionOrOpts?: SlotPosition | SlotMountOptions,
    replace?: boolean,
    pluginName: string = 'unknown',
  ): void {
    const opts = this._normalizeOptions(positionOrOpts, replace);
    const key = this._entryKey(pluginName, slot, opts.id || el.dataset.slotId || el.id);
    this._prepareElement(el, slot, pluginName, key);

    const target = this._target(slot);
    if (!target) {
      console.debug(`[Slot] "${slot}" not in DOM yet - queued (plugin: ${pluginName}, key: ${key})`);
      this._queue(slot, { el, pluginName, key, opts });
      return;
    }

    console.log(`[Slot] mount "${slot}" plugin=${pluginName} key=${key} position=${opts.position || 'append'} replace=${opts.replace || false}`);
    this._mountInto(target, slot, { el, pluginName, key, opts });
  }

  unmount(slot: string, el: HTMLElement): void {
    console.log(`[Slot] unmount element from "${slot}"`);
    if (el.parentElement) el.remove();
    const entries = this._entries.get(slot);
    if (!entries) return;
    const idx = entries.findIndex(e => e.element === el);
    if (idx >= 0) entries.splice(idx, 1);
    if (entries.length === 0) this._entries.delete(slot);
  }

  unmountById(slot: string, pluginName: string, id: string): void {
    const key = this._entryKey(pluginName, slot, id);
    this._removeEntry(slot, entry => entry.pluginName === pluginName && entry.key === key);
    this._removePending(slot, item => item.pluginName === pluginName && item.key === key);
  }

  unmountAll(slot: string, pluginName?: string): void {
    const entries = this._entries.get(slot);
    const count = entries ? (pluginName ? entries.filter(e => e.pluginName === pluginName).length : entries.length) : 0;
    console.log(`[Slot] unmountAll "${slot}" plugin=${pluginName || '*'} count=${count}`);
    this._removeEntry(slot, entry => !pluginName || entry.pluginName === pluginName);
    this._removePending(slot, item => !pluginName || item.pluginName === pluginName);
  }

  removeByPlugin(pluginName: string): void {
    console.log(`[Slot] removeByPlugin "${pluginName}"`);
    for (const slot of Array.from(this._entries.keys())) {
      this._removeEntry(slot, entry => entry.pluginName === pluginName);
    }
    for (const slot of Array.from(this._pending.keys())) {
      this._removePending(slot, item => item.pluginName === pluginName);
    }
  }

  _onSlotReady(slot: string): void {
    const pending = this._pending.get(slot);
    if (!pending || pending.length === 0) return;
    const target = this._target(slot);
    if (!target) {
      console.warn(`[Slot] "${slot}" still not in DOM after ready signal`);
      return;
    }
    this._pending.delete(slot);
    console.log(`[Slot] "${slot}" DOM ready - draining ${pending.length} queued mounts`);
    for (const item of pending) this._mountInto(target, slot, item);
  }

  private _normalizeOptions(positionOrOpts?: SlotPosition | SlotMountOptions, replace?: boolean): SlotMountOptions {
    if (typeof positionOrOpts === 'object' && positionOrOpts !== null) {
      return {
        position: positionOrOpts.position,
        replace: positionOrOpts.replace,
        id: positionOrOpts.id,
        priority: positionOrOpts.priority,
      };
    }
    return { position: positionOrOpts, replace };
  }

  private _target(slot: string): Element | null {
    return document.querySelector(`[data-slot="${CSS.escape(slot)}"]`);
  }

  private _entryKey(pluginName: string, slot: string, id?: string): string {
    return `${pluginName}:${slot}:${id || 'default'}`;
  }

  private _prepareElement(el: HTMLElement, slot: string, pluginName: string, key: string): void {
    el.dataset.slot = slot;
    el.dataset.pluginName = pluginName;
    el.dataset.slotKey = key;
  }

  private _queue(slot: string, item: PendingSlotEntry): void {
    const pending = this._pending.get(slot) || [];
    const existing = pending.findIndex(p => p.pluginName === item.pluginName && p.key === item.key);
    if (existing >= 0) pending.splice(existing, 1);
    pending.push(item);
    this._pending.set(slot, pending);
  }

  private _mountInto(target: Element, slot: string, item: PendingSlotEntry): void {
    if (item.opts.replace) {
      this.unmountAll(slot, item.pluginName);
    } else {
      this._removeEntry(slot, entry => entry.pluginName === item.pluginName && entry.key === item.key);
    }

    const entry: SlotEntry = {
      element: item.el,
      pluginName: item.pluginName,
      key: item.key,
      priority: item.opts.priority ?? 0,
      insertedAt: ++this._counter,
    };
    const entries = this._entries.get(slot) || [];
    entries.push(entry);
    this._entries.set(slot, entries);

    target.appendChild(item.el);
    this._sortSlot(target, slot, item.opts.position);
  }

  private _sortSlot(target: Element, slot: string, position?: SlotPosition): void {
    const entries = this._entries.get(slot);
    if (!entries) return;
    entries.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return position === 'prepend' ? b.insertedAt - a.insertedAt : a.insertedAt - b.insertedAt;
    });
    for (const entry of entries) target.appendChild(entry.element);
  }

  private _removeEntry(slot: string, predicate: (entry: SlotEntry) => boolean): void {
    const entries = this._entries.get(slot);
    if (!entries) return;
    const kept: SlotEntry[] = [];
    for (const entry of entries) {
      if (predicate(entry)) {
        if (entry.element.parentElement) entry.element.remove();
      } else {
        kept.push(entry);
      }
    }
    if (kept.length === 0) this._entries.delete(slot);
    else this._entries.set(slot, kept);
  }

  private _removePending(slot: string, predicate: (item: PendingSlotEntry) => boolean): void {
    const pending = this._pending.get(slot);
    if (!pending) return;
    const kept = pending.filter(item => !predicate(item));
    if (kept.length === 0) this._pending.delete(slot);
    else this._pending.set(slot, kept);
  }
}

export const slotRegistry = new SlotRegistry();
