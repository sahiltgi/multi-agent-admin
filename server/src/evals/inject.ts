// In-process HTTP for the eval runner (spec eval-runner, rule 6): calls the Express app as a
// function with a node:http request and response. No listener is opened and no fetch is made.
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

export interface InjectRequest {
  url: string;
  demoUser: string;
  body: unknown;
}

export interface InjectResponse {
  status: number;
  json: unknown; // null when the body isn't JSON
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function inject(app: Handler, r: InjectRequest): Promise<InjectResponse> {
  const payload = Buffer.from(JSON.stringify(r.body), 'utf8');
  const req = new IncomingMessage(new Socket()); // never connected
  req.method = 'POST';
  req.url = r.url;
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    'x-demo-user': r.demoUser,
  };
  req.push(payload);
  req.push(null);

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const collect = (chunk: unknown, encoding: unknown): void => {
    if (typeof chunk === 'string') {
      chunks.push(
        Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'),
      );
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    }
  };

  return new Promise<InjectResponse>((resolve, reject) => {
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      collect(chunk, encoding);
      const done = typeof encoding === 'function' ? encoding : cb;
      if (typeof done === 'function') (done as () => void)();
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      if (typeof chunk !== 'function') collect(chunk, encoding);
      resolve({ status: res.statusCode, json: parseJson(Buffer.concat(chunks).toString('utf8')) });
      const done = [chunk, encoding, cb].find((x) => typeof x === 'function');
      if (typeof done === 'function') (done as () => void)();
      return res;
    }) as typeof res.end;
    try {
      app(req, res);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('request failed'));
    }
  });
}
