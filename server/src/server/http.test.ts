// AT-17, real-socket half (specs/mongo-persistence.md rule 13): close() stops new connections
// and resolves only after the in-flight request has finished.
import express from 'express';
import { createServer, connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { listenHttp } from './http.js';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const addr = probe.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  await new Promise<void>((resolve) =>
    probe.close(() => {
      resolve();
    }),
  );
  return addr.port;
}

function tryConnect(port: number): Promise<'connected' | 'refused'> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', () => {
      resolve('refused');
    });
  });
}

describe('listenHttp', () => {
  it('AT-17: close() refuses new connections and lets the in-flight request finish with 200', async () => {
    let entered: () => void = () => undefined;
    const handlerEntered = new Promise<void>((r) => {
      entered = r;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = express();
    app.get('/slow', async (_req, res) => {
      entered();
      await gate;
      res.status(200).json({ ok: true });
    });

    const port = await freePort();
    const server = await listenHttp(app, port, '127.0.0.1');
    try {
      const inFlight = fetch(`http://127.0.0.1:${String(port)}/slow`, {
        headers: { connection: 'close' },
      });
      await handlerEntered;

      let closed = false;
      const closing = server.close().then(() => {
        closed = true;
      });
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(await tryConnect(port)).toBe('refused');
      expect(closed).toBe(false);

      release();
      const res = await inFlight;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      await closing;
      expect(closed).toBe(true);
    } finally {
      release();
      server.forceClose();
    }
  });

  it('AT-17: forceClose() ends an open request without waiting for it', async () => {
    let entered: () => void = () => undefined;
    const handlerEntered = new Promise<void>((r) => {
      entered = r;
    });
    const app = express();
    app.get('/hang', () => {
      entered();
    });
    const port = await freePort();
    const server = await listenHttp(app, port, '127.0.0.1');
    const inFlight = fetch(`http://127.0.0.1:${String(port)}/hang`, {
      headers: { connection: 'close' },
    });
    const outcome = inFlight.then(
      () => 'done',
      () => 'failed',
    );
    await handlerEntered;
    server.forceClose();
    expect(await outcome).toBe('failed');
  });
});
