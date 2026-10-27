// Read ports of the audit view routes (spec audit-view, "Ports"). The file system adapters are in
// fs-readers.ts; tests use in-memory.ts or plain objects.
import type { TraceReadDeps } from '../http/approvals/trace.js';

export type FileRead =
  | { status: 'ok'; text: string }
  | { status: 'missing' } // ENOENT
  | { status: 'unreadable' }; // symlink, not a regular file, over the size cap, or not valid UTF-8

export interface EvalResultsReader {
  /** Every name in the fixed results directory that matches RESULT_FILE_RE, sorted by name. [] if the directory is missing. */
  list(): Promise<{ name: string; read: FileRead }[]>;
}

export interface DocReader {
  devMetrics(): Promise<FileRead>; // fixed path from boot config
  aiLog(): Promise<FileRead>; // fixed path from boot config
}

export interface AuditViewDeps {
  trace: TraceReadDeps; // the approval API's directory, subjects and auditReader
  evalResults: EvalResultsReader;
  docs: DocReader;
}
