// Date helpers shared by the server wiring and the eval runner.

/** UTC calendar date of the caller's clock (leave-agent D-13). */
export const toIsoDate = (nowIso: string): string => nowIso.slice(0, 10);
