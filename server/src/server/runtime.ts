// Production clock, scheduler and id generator (spec mongo-persistence, rule 12; D-17). The only
// real clock reads for the running server; gate, http, intake and agents receive them injected.
import { randomUUID } from 'node:crypto';
import type { Clock, Scheduler } from '../agents/runtime.js';

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

export const timerScheduler: Scheduler = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Unguessable ids, so request ids and traces can't be enumerated (request-intake D-9). */
export function uuidIdGen(): string {
  return `req-${randomUUID()}`;
}
