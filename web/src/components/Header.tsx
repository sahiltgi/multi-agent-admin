// App header (spec web-shell, rules 1 and 5). Tabs come from the persona map and are UX only.
import { NavLink } from 'react-router';
import { usePersona } from '../persona/context.js';
import type { RouteKey } from '../persona/personas.js';
import { PRODUCT_NAME } from '../texts.js';
import { PersonaSwitcher } from './PersonaSwitcher.js';

const TABS: Readonly<Record<RouteKey, { to: string; label: string }>> = {
  chat: { to: '/chat', label: 'Chat' },
  queue: { to: '/queue', label: 'Queue' },
  audit: { to: '/audit', label: 'Audit' },
};

export function Header() {
  const { persona } = usePersona();
  return (
    <header className="header">
      <span className="brand">{PRODUCT_NAME}</span>
      <nav className="tabs">
        {persona.nav.map((r) => (
          <NavLink key={r} to={TABS[r].to} className="tab">
            {TABS[r].label}
          </NavLink>
        ))}
      </nav>
      <PersonaSwitcher />
    </header>
  );
}
