// Fixed web texts (spec web-shell, "Fixed web texts"). Server text is never mixed into these.
export const PRODUCT_NAME = 'HR & Admin Ops';

export const TEXT = {
  loading: 'Loading…',
  queueEmpty: 'No approval items to show.',
  auditIdle: 'Enter a request id to load its audit events.',
  auditEmpty: 'No events for this request.',
  chatIdle: 'Send a message to start.',
  noGateResult: 'No gate result',
  networkError: "Can't reach the server. Check that it is running.",
  invalidResponse: "The server sent a response this app couldn't read.",
  notFound: 'Page not found.',
  goToChat: 'Go to chat',
} as const;
