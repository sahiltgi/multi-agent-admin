// Secret scrubbing for anything written to stdout or stderr (spec domain-schemas rule 15;
// spec mongo-persistence rule 14). Driver and SDK errors can echo a URI or key verbatim.

/** The URI and its credentials, in every form a driver error might echo them. */
export function secretsOfUri(uri: string): string[] {
  const secrets = [uri];
  const userinfo = /^mongodb(?:\+srv)?:\/\/([^@/]*)@/.exec(uri)?.[1];
  if (userinfo !== undefined && userinfo !== '') {
    secrets.push(userinfo);
    const password = userinfo.slice(userinfo.indexOf(':') + 1);
    if (userinfo.includes(':') && password !== '') {
      secrets.push(password);
      try {
        secrets.push(decodeURIComponent(password));
      } catch {
        // Not percent-encoded; the raw form is already covered.
      }
    }
  }
  return secrets;
}

/** Replaces every non-empty secret with `[redacted]`, longest first so a whole URI goes first. */
export function createScrubber(secrets: readonly string[]): (text: string) => string {
  const ordered = [...new Set(secrets.filter((s) => s !== ''))].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((acc, s) => acc.split(s).join('[redacted]'), text);
}
