// AnoClaw Frontend — Message List Model
// Observable message array with change events for the UI to react to.

import { EventEmitter } from '../EventEmitter.js';
import type { Message } from '../types.js';

export class MessageListModel extends EventEmitter {
  private _messages: Message[] = [];
  private static readonly MAX_MESSAGES = 2000; // trim old messages when exceeding this count

  get length(): number {
    return this._messages.length;
  }

  getMessage(index: number): Message | undefined {
    return this._messages[index];
  }

  get messages(): ReadonlyArray<Message> {
    return this._messages;
  }

  appendMessage(msg: Message): void {
    this._messages.push(msg);
    // Trim first half of old messages when exceeding limit
    if (this._messages.length > MessageListModel.MAX_MESSAGES) {
      const trimCount = Math.floor(MessageListModel.MAX_MESSAGES / 2);
      const trimmedIds = this._messages.slice(0, trimCount).map(m => m.id);
      this._messages = this._messages.slice(-trimCount);
      this.emit('rowsRemoved', 0, trimCount, trimmedIds);
    }
    this.emit('rowsInserted', this._messages.length - 1, 1);
  }

  updateMessage(index: number, msg: Message): void {
    if (index < 0 || index >= this._messages.length) return;
    this._messages[index] = msg;
    this.emit('dataChanged', index, 1);
  }

  /** Replace last message — used during streaming to update in place */
  replaceLastMessage(msg: Message): void {
    if (this._messages.length === 0) {
      this.appendMessage(msg);
      return;
    }
    this._messages[this._messages.length - 1] = msg;
    this.emit('dataChanged', this._messages.length - 1, 1);
  }

  /** Get the last message, useful for streaming append */
  getLastMessage(): Message | undefined {
    if (this._messages.length === 0) return undefined;
    return this._messages[this._messages.length - 1];
  }

  removeMessage(index: number): void {
    if (index < 0 || index >= this._messages.length) return;
    this._messages.splice(index, 1);
    this.emit('rowsRemoved', index, 1);
  }

  clear(): void {
    const count = this._messages.length;
    this._messages = [];
    if (count > 0) {
      this.emit('rowsRemoved', 0, count);
    }
  }

  /** Find index of a message by id */
  indexOf(id: string): number {
    return this._messages.findIndex((m) => m.id === id);
  }

  /** Filter by type */
  filterByType(type: string): Message[] {
    return this._messages.filter((m) => m.type === type);
  }
}
