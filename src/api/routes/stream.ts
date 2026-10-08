import { Router } from 'express';
import { bus, type AppEvent } from '../../events.js';
import type { AppContext } from '../context.js';

/** Server-Sent Events: pushes scan progress, poll cycles and device events to the dashboard. */
export function streamRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (Ingress / nginx)
    });

    const send = (e: AppEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    send({ type: 'hello', data: { scan: ctx.scanner.getStatus(), lastCycle: ctx.poller.stats }, ts: Date.now() });

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    bus.on('event', send);
    req.on('close', () => {
      clearInterval(heartbeat);
      bus.off('event', send);
    });
  });

  return r;
}
