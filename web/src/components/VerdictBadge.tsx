// Verdict badge (spec web-shell, rule 9). Display only: the text is the server's verdict unchanged,
// and the tone is an exact-string lookup, never a prefix or substring match.
export type Tone = 'neutral' | 'amber' | 'plum' | 'grey';

const VERDICT_TONE: Readonly<Record<string, Tone>> = {
  ROUTE_TO_MANAGER: 'neutral',
  AUTO_ANSWER: 'neutral',
  AUTO: 'neutral',
  ROUTE_TO_MANAGER_WITH_FLAGS: 'amber',
  MANAGER: 'amber',
  ESCALATE_TO_HR: 'plum',
  RETURN_TO_EMPLOYEE: 'grey',
};

function toneOf(verdict: string): Tone {
  return Object.hasOwn(VERDICT_TONE, verdict) ? (VERDICT_TONE[verdict] ?? 'neutral') : 'neutral';
}

export function VerdictBadge({ verdict }: { verdict: string }) {
  return (
    <span className="badge mono" data-tone={toneOf(verdict)}>
      {verdict}
    </span>
  );
}
