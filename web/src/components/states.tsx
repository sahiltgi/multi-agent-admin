// Loading, empty and error states (spec web-shell, rules 8 and 12). An error shows the server's
// parsed message and code, or a fixed text; raw bodies and exception messages never reach the DOM.
import type { ApiFailure } from '../api/client.js';
import { TEXT } from '../texts.js';

export function Loading() {
  return (
    <p role="status" className="state">
      {TEXT.loading}
    </p>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="state">{text}</p>;
}

export function ErrorState({ failure }: { failure: ApiFailure }) {
  if (failure.kind === 'aborted') return null; // superseded by a persona switch (rule 4)
  return (
    <div role="alert" className="state state-error">
      {failure.kind === 'http' ? (
        <>
          <span>{failure.error.message}</span> <span className="mono">{failure.error.code}</span>
        </>
      ) : failure.kind === 'network' ? (
        TEXT.networkError
      ) : (
        TEXT.invalidResponse
      )}
    </div>
  );
}
