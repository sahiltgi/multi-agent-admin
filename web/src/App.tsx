// The web shell (spec web-shell). The router comes from the caller: BrowserRouter in main.tsx,
// MemoryRouter in tests. Routes are keyed by persona so a switch drops their data (rule 4).
import { useState } from 'react';
import { Navigate, Route, Routes, useMatch } from 'react-router';
import type { AuditTab } from './components/audit/AuditTabs.js';
import { Header } from './components/Header.js';
import { usePersona } from './persona/context.js';
import { PersonaProvider } from './persona/PersonaProvider.js';
import { Audit } from './routes/Audit.js';
import { Chat } from './routes/Chat.js';
import { NotFound } from './routes/NotFound.js';
import { Onboarding } from './routes/Onboarding.js';
import { Queue } from './routes/Queue.js';

function Shell() {
  const { persona } = usePersona();
  const id = persona.employeeId;
  // The last audit id lives only while the path stays /audit: a persona switch there re-sends it
  // (rule 4); leaving /audit forgets it, so coming back (by link or Back) starts idle.
  // Uses the router's own matcher, so `/audit/` and `/Audit` count as /audit too.
  const onAudit = useMatch('/audit') !== null;
  const [auditRequestId, setAuditRequestId] = useState<string | null>(null);
  if (!onAudit && auditRequestId !== null) setAuditRequestId(null);
  // spec audit-view, rule 24: the selected audit tab survives a persona switch, likewise.
  const [auditTab, setAuditTab] = useState<AuditTab>('trace');
  if (!onAudit && auditTab !== 'trace') setAuditTab('trace');
  return (
    <>
      <Header />
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<Chat key={id} />} />
          <Route path="/queue" element={<Queue key={id} />} />
          <Route path="/onboarding" element={<Onboarding key={id} />} />
          <Route
            path="/audit"
            element={
              <Audit
                key={id}
                lastRequestId={auditRequestId}
                onLoad={setAuditRequestId}
                tab={auditTab}
                onTab={setAuditTab}
              />
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </>
  );
}

export function App() {
  return (
    <PersonaProvider>
      <Shell />
    </PersonaProvider>
  );
}
