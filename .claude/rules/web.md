---
paths:
  - 'web/**/*.{ts,tsx}'
---

# Web UI rules

- Never compute, infer or override a verdict in the browser. Render the verdict, rule results (✓/✗ with reason) and policy version exactly as the server returns them.
- Role-based hiding is UX only. The server enforces every permission, so never rely on the UI for access control.
- Parse every API response with Zod before using it.
- Approving a flagged card requires a comment. Enforce it in the UI and expect the server to enforce it too.
- Only non-secret config goes in `VITE_*` env vars. Anything in the bundle is public.
- Fixtures and demo data are synthetic only.
- Tests sit next to components as `*.test.ts(x)` and run under jsdom via `npm test`.
- Dev server: `npm run dev -w web`. `npm run preview -w web` serves `web/dist` after `npm run build`.
