// In-memory readers for tests and local wiring (spec audit-view, "Files in scope").
import type { DocReader, EvalResultsReader, FileRead } from './ports.js';

export class InMemoryEvalResultsReader implements EvalResultsReader {
  constructor(private readonly files: readonly { name: string; read: FileRead }[] = []) {}

  list(): Promise<{ name: string; read: FileRead }[]> {
    return Promise.resolve(
      [...this.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
  }
}

export class InMemoryDocReader implements DocReader {
  constructor(
    private readonly files: { devMetrics: FileRead; aiLog: FileRead } = {
      devMetrics: { status: 'missing' },
      aiLog: { status: 'missing' },
    },
  ) {}

  devMetrics(): Promise<FileRead> {
    return Promise.resolve(this.files.devMetrics);
  }

  aiLog(): Promise<FileRead> {
    return Promise.resolve(this.files.aiLog);
  }
}
