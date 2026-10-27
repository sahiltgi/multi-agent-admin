// File system adapters of the audit view (spec audit-view, rules 11 and 16): the module's only
// file I/O. Every path is fixed at boot; no request value reaches one. A file is opened only after
// lstat reports a regular file within its cap, and is opened without following symlinks.
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import type { DocReader, EvalResultsReader, FileRead } from './ports.js';
import { RESULT_FILE_RE } from './schemas.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const RESULT_FILE_CAP = MIB;
const DEV_METRICS_CAP = 512 * KIB;
const AI_LOG_CAP = MIB;
const MAX_RESULT_FILES = 1000;

const isErrno = (err: unknown, code: string): boolean =>
  err instanceof Error && 'code' in err && err.code === code;

/** ENOENT is `missing`; any other lstat error is thrown (the route turns it into a 500). */
async function readCapped(path: string, cap: number): Promise<FileRead> {
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { status: 'missing' };
    throw err;
  }
  if (!info.isFile() || info.size > cap) return { status: 'unreadable' };
  let handle;
  try {
    // O_NOFOLLOW: a path swapped for a symlink after lstat is refused, not followed.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { status: 'unreadable' };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > cap) return { status: 'unreadable' };
    // Read at most cap + 1 bytes, so a file that grew after fstat is never read past its cap.
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > cap) return { status: 'unreadable' };
    const bytes = buffer.subarray(0, length);
    try {
      return { status: 'ok', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { status: 'unreadable' }; // not valid UTF-8
    }
  } finally {
    await handle.close();
  }
}

export class FsEvalResultsReader implements EvalResultsReader {
  private readonly dir: string;

  constructor(evalResultsDir: string) {
    this.dir = resolve(evalResultsDir);
  }

  async list(): Promise<{ name: string; read: FileRead }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return [];
      throw err;
    }
    const kept = names
      .filter((n) => RESULT_FILE_RE.test(n))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out: { name: string; read: FileRead }[] = [];
    for (const [i, name] of kept.entries()) {
      const path = resolve(this.dir, name);
      // Names past the cap, or that could leave the directory, are listed unopened and skipped.
      const inside = basename(name) === name && path.startsWith(this.dir + sep);
      out.push({
        name,
        read:
          i < MAX_RESULT_FILES && inside
            ? await readCapped(path, RESULT_FILE_CAP)
            : { status: 'unreadable' },
      });
    }
    return out;
  }
}

export class FsDocReader implements DocReader {
  private readonly devMetricsPath: string;
  private readonly aiLogPath: string;

  constructor(paths: { devMetricsPath: string; aiLogPath: string }) {
    this.devMetricsPath = paths.devMetricsPath;
    this.aiLogPath = paths.aiLogPath;
  }

  devMetrics(): Promise<FileRead> {
    return readCapped(this.devMetricsPath, DEV_METRICS_CAP);
  }

  aiLog(): Promise<FileRead> {
    return readCapped(this.aiLogPath, AI_LOG_CAP);
  }
}
