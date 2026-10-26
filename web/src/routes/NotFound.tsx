import { Link } from 'react-router';
import { TEXT } from '../texts.js';

export function NotFound() {
  return (
    <section>
      <p className="state">{TEXT.notFound}</p>
      <Link to="/chat">{TEXT.goToChat}</Link>
    </section>
  );
}
