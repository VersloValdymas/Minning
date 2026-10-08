import { EventEmitter } from 'node:events';

export interface AppEvent {
  type: string;
  data: unknown;
  ts: number;
}

/** In-process event bus; the SSE endpoint forwards everything to the dashboard. */
class EventBus extends EventEmitter {
  publish(type: string, data: unknown): void {
    this.emit('event', { type, data, ts: Date.now() } satisfies AppEvent);
  }
}

export const bus = new EventBus();
bus.setMaxListeners(200);
