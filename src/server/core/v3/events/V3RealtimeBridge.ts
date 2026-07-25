import type { WsServer } from '../../../infra/network/WsServer.js';
import { AppendOnlyEventStore } from '../store/AppendOnlyEventStore.js';
import { INSTALL_COMPANY_SCOPE } from '../store/CompanyRepository.js';
import { V3EventHub, type V3DomainEnvelope } from './V3EventHub.js';

interface V3SubscribeMessage {
  type: 'v3_subscribe';
  companyAfterRevision?: number;
  works?: Array<{ workId: string; afterRevision: number }>;
}

type WsReply = (data: Record<string, unknown>) => boolean;

/**
 * Durable revision replay followed by EventHub live tail.
 *
 * The client first obtains a REST snapshot, then subscribes with the snapshot
 * revisions. Replayed and live events use the same envelope; clients dedupe by
 * scopeId + revision.
 */
export class V3RealtimeBridge {
  private unsubscribeHub: (() => void) | null = null;
  private messageListener: (sessionId: string, message: Record<string, unknown>, reply?: WsReply) => void;

  constructor(
    private readonly ws: WsServer,
    private readonly store = new AppendOnlyEventStore(),
    private readonly hub = V3EventHub.getInstance(),
  ) {
    this.messageListener = (_sessionId, message, reply) => {
      if (message.type !== 'v3_subscribe' || !reply) return;
      void this.replay(message as unknown as V3SubscribeMessage, reply);
    };
  }

  start(): void {
    if (this.unsubscribeHub) return;
    this.unsubscribeHub = this.hub.subscribe((envelope) => {
      this.ws.broadcast(toWireEvent(envelope, false));
    });
    this.ws.on('message', this.messageListener);
  }

  stop(): void {
    this.unsubscribeHub?.();
    this.unsubscribeHub = null;
    this.ws.off('message', this.messageListener);
  }

  private async replay(message: V3SubscribeMessage, reply: WsReply): Promise<void> {
    try {
      const companyEvents = await this.store.readCompanyEvents(INSTALL_COMPANY_SCOPE);
      const companyAfter = safeRevision(message.companyAfterRevision);
      const companyCurrent = companyEvents.at(-1)?.revision ?? 0;
      if (companyAfter > companyCurrent) {
        reply(snapshotRequired('company', INSTALL_COMPANY_SCOPE, companyCurrent));
      } else {
        for (const event of companyEvents) {
          if (event.revision > companyAfter) reply(toWireEvent(event, true));
        }
      }

      const works = Array.isArray(message.works) ? message.works.slice(0, 100) : [];
      for (const subscription of works) {
        if (!subscription || typeof subscription.workId !== 'string') continue;
        const events = await this.store.readWorkEvents(subscription.workId);
        const after = safeRevision(subscription.afterRevision);
        const current = events.at(-1)?.revision ?? 0;
        if (after > current) {
          reply(snapshotRequired('work', subscription.workId, current));
          continue;
        }
        for (const event of events) {
          if (event.revision > after) reply(toWireEvent(event, true));
        }
      }
      reply({
        type: 'v3_subscribed',
        companyRevision: companyCurrent,
        workIds: works.map((entry) => entry.workId),
      });
    } catch (error) {
      reply({
        type: 'v3_snapshot_required',
        scopeType: 'all',
        scopeId: '*',
        currentRevision: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function toWireEvent(
  envelope: V3DomainEnvelope,
  replayed: boolean,
): Record<string, unknown> {
  return {
    type: 'v3_event',
    scopeType: envelope.scopeType,
    scopeId: envelope.scopeId,
    revision: envelope.revision,
    eventId: envelope.eventId,
    occurredAt: envelope.occurredAt,
    event: envelope.event,
    replayed,
  };
}

function snapshotRequired(
  scopeType: 'company' | 'work',
  scopeId: string,
  currentRevision: number,
): Record<string, unknown> {
  return {
    type: 'v3_snapshot_required',
    scopeType,
    scopeId,
    currentRevision,
    reason: 'client_revision_ahead',
  };
}

function safeRevision(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
