// Express 5 app for the approval queue API (spec approval-queue; ADR-0001, ADR-0005).
// Order: identity (401 before any store read or body parse), JSON body, routes, 404, errors.
// createApp reads no env and no clock: the caller runs assertDemoIdentityAllowed first.
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
} from 'express';
import type { ApprovalApiDeps } from './approvals/ports.js';
import { createApprovalRoutes } from './approvals/routes.js';
import { errorBody, HttpError } from './errors.js';
import { DEMO_USER_HEADER, resolveActor, type Actor } from './identity.js';
import type { RouteDefinition } from './route.js';

const JSON_BODY_LIMIT = '16kb';

// Body-parser errors (malformed JSON, too large) carry a client status and a `type`.
function isBodyParserError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'type' in err &&
    typeof err.type === 'string' &&
    'status' in err &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status < 500
  );
}

export function createApp(
  deps: ApprovalApiDeps,
  extraRoutes: readonly RouteDefinition[] = [],
): Express {
  const app = express();
  app.disable('x-powered-by');
  const actors = new WeakMap<Request, Actor>();

  const identify: RequestHandler = async (req, _res, next) => {
    const actor = await resolveActor(deps.directory, req.headers[DEMO_USER_HEADER]);
    if (actor === null) throw new HttpError('unauthenticated');
    actors.set(req, actor);
    next();
  };
  app.use(identify);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  for (const route of [...createApprovalRoutes(deps), ...extraRoutes]) {
    app[route.method](route.path, async (req, res) => {
      const actor = actors.get(req);
      if (actor === undefined) throw new HttpError('unauthenticated');
      const body: unknown = req.body ?? {};
      const out = await route.handle({ actor, params: req.params, query: req.query, body });
      res.status(200).json(out);
    });
  }

  app.use((_req, _res, next) => {
    next(new HttpError('not_found'));
  });

  // Exception messages and stacks never reach the client.
  const onError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json(errorBody(err.code, err.issues));
    } else if (isBodyParserError(err)) {
      res.status(400).json(errorBody('invalid_request'));
    } else {
      res.status(500).json(errorBody('internal_error'));
    }
  };
  app.use(onError);
  return app;
}
