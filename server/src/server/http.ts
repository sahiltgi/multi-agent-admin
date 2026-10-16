// HTTP listener with graceful close (spec mongo-persistence, rule 13).
import { createServer } from 'node:http';
import type { Express } from 'express';

export interface ListeningServer {
  /** Stops accepting connections; resolves once in-flight requests have finished. */
  close(): Promise<void>;
  /** Ends every open connection at once, for a second signal or an expired grace period. */
  forceClose(): void;
}

export function listenHttp(app: Express, port: number, host: string): Promise<ListeningServer> {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => {
              if (err) fail(err);
              else done();
            });
            server.closeIdleConnections(); // keep-alive sockets with no request in flight
          }),
        forceClose: () => {
          server.closeAllConnections();
        },
      });
    });
  });
}
