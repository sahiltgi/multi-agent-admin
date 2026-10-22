// The onboarding API (spec onboarding-api, rule 1; OQ-1): create, list, read and task status, all
// under /onboarding. Humans mark tasks here; no agent can. The task list itself changes only through
// an approved deviation in the approval queue (onboarding rule 23), never through these routes.
import type { RouteDefinition } from '../http/route.js';
import { createCreateRoute } from './create.js';
import type { OnboardingRouteDeps } from './ports.js';
import { createReadRoutes } from './read.js';
import { createTaskStatusRoute } from './tasks.js';

export type { OnboardingPolicyView, OnboardingRouteDeps } from './ports.js';

export function createOnboardingRoutes(deps: OnboardingRouteDeps): RouteDefinition[] {
  return [createCreateRoute(deps), ...createReadRoutes(deps), createTaskStatusRoute(deps)];
}
