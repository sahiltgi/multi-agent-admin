// Policy loaders (spec leave-policy, rules 11–14; spec policy-qa, rule 3). Run once at boot; they
// do I/O, so they live outside server/src/gate/. The gates receive the loaded policies they return.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  LineCounter,
  isAlias,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  visit,
  type Document,
  type YAMLError,
} from 'yaml';
import { z } from 'zod';
import { LeavePolicyV1, LoadedLeavePolicy } from '../gate/leave-policy.schema.js';
import { LoadedOnboardingPolicy, OnboardingPolicyV1 } from '../gate/onboarding-policy.schema.js';
import { LoadedQaPolicy, QaPolicyV1 } from '../gate/qa-policy.schema.js';

const IssuePath = z.array(z.union([z.string(), z.number()]));
type IssuePath = z.infer<typeof IssuePath>;

export const PolicyLoadErrorShape = z
  .object({
    filePath: z.string().min(1),
    kind: z.enum(['read', 'yaml', 'schema']),
    issues: z
      .array(
        z
          .object({
            path: IssuePath, // e.g. ['blackoutWindows', 0, 'end']
            line: z.number().int().positive().optional(), // YAML errors only
            message: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PolicyLoadErrorShape = z.infer<typeof PolicyLoadErrorShape>;
export type PolicyLoadKind = PolicyLoadErrorShape['kind'];
export type PolicyLoadIssue = PolicyLoadErrorShape['issues'][number];

const formatPath = (path: IssuePath): string => (path.length === 0 ? '(root)' : path.join('.'));

/**
 * Thrown for any read, YAML or schema failure; no partial policy is ever returned.
 * Messages name paths, keys and lines, never values from the file (rule 14).
 */
export class PolicyLoadError extends Error {
  readonly filePath: string;
  readonly kind: PolicyLoadKind;
  readonly issues: PolicyLoadIssue[];

  /** `label` names the policy in the message: "Leave" (the default) or "QA". */
  constructor(shape: PolicyLoadErrorShape, label = 'Leave') {
    const { filePath, kind, issues } = PolicyLoadErrorShape.parse(shape);
    const lines = issues.map(
      (i) =>
        `  - ${formatPath(i.path)}${i.line === undefined ? '' : ` (line ${String(i.line)})`}: ${i.message}`,
    );
    super([`${label} policy failed to load (${kind}): ${filePath}`, ...lines].join('\n'));
    this.name = 'PolicyLoadError';
    this.filePath = filePath;
    this.kind = kind;
    this.issues = issues;
  }
}

/** Path of a YAML node from its visit() ancestors: map keys and sequence indexes. */
function nodePath(ancestors: readonly unknown[], leaf: unknown): IssuePath {
  const chain = [...ancestors, leaf];
  const path: IssuePath = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const parent = chain[i];
    const child = chain[i + 1];
    if (isPair(parent) && parent.value === child && isScalar(parent.key)) {
      path.push(String(parent.key.value));
    } else if (isSeq(parent)) {
      path.push(parent.items.indexOf(child));
    }
  }
  return path;
}

/** Messages come from the error code and key names only; yaml's own text quotes the source. */
function yamlIssue(doc: Document.Parsed, e: YAMLError): PolicyLoadIssue {
  const line = e.linePos?.[0].line;
  if (e.code === 'DUPLICATE_KEY') {
    let issue: PolicyLoadIssue | undefined;
    visit(doc, {
      Pair(_, pair, ancestors) {
        if (isScalar(pair.key) && pair.key.range?.[0] === e.pos[0]) {
          const key = String(pair.key.value);
          issue = {
            path: [...nodePath(ancestors, pair), key],
            line,
            message: `duplicate key "${key}"`,
          };
          return visit.BREAK;
        }
        return undefined;
      },
    });
    if (issue !== undefined) return issue;
  }
  return {
    path: [],
    line,
    message: `YAML ${e.name === 'YAMLWarning' ? 'warning' : 'error'} ${e.code}`,
  };
}

/** Anchors and aliases are rejected so the file reads literally (D-6). */
function aliasIssues(doc: Document.Parsed, lines: LineCounter): PolicyLoadIssue[] {
  const issues: PolicyLoadIssue[] = [];
  visit(doc, (_, node, ancestors) => {
    if (!isNode(node)) return;
    const what = isAlias(node) ? 'alias' : node.anchor !== undefined ? 'anchor' : undefined;
    if (what === undefined) return;
    const offset = node.range?.[0];
    issues.push({
      path: nodePath(ancestors, node),
      line: offset === undefined ? undefined : lines.linePos(offset).line,
      message: `YAML ${what}s are not allowed in policy files`,
    });
  });
  return issues;
}

function readBytes(filePath: string, label: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? String(e.code) : 'unknown error';
    throw new PolicyLoadError(
      { filePath, kind: 'read', issues: [{ path: [], message: `cannot read file (${code})` }] },
      label,
    );
  }
}

function parseYaml(filePath: string, bytes: Buffer, label: string): unknown {
  const fail = (issues: PolicyLoadIssue[]) =>
    new PolicyLoadError({ filePath, kind: 'yaml', issues }, label);
  let source: string;
  try {
    // ignoreBOM keeps a leading BOM in the text; the YAML parser skips it.
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw fail([{ path: [], message: 'file is not valid UTF-8' }]);
  }

  const lines = new LineCounter();
  const docs = parseAllDocuments(source, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    lineCounter: lines,
  });
  const [doc] = docs;
  if (doc?.contents == null) throw fail([{ path: [], message: 'file is empty' }]);
  if (docs.length > 1) {
    throw fail([
      {
        path: [],
        message: `expected exactly one YAML document, found ${String(docs.length)}`,
      },
    ]);
  }
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0) throw fail(problems.map((e) => yamlIssue(doc, e)));
  const aliases = aliasIssues(doc, lines);
  if (aliases.length > 0) throw fail(aliases);
  return doc.toJS() as unknown;
}

/**
 * Reads, hashes, parses and validates a policy file against `schema`; the version must match the
 * file stem. policyHash is SHA-256 over the raw bytes, before any decoding or normalisation
 * (leave-policy rule 12).
 */
function loadPolicyFile<T extends { version: string }>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string,
): { policy: T; policyVersion: string; policyHash: string } {
  const bytes = readBytes(filePath, label);
  const policyHash = createHash('sha256').update(bytes).digest('hex');
  const raw = parseYaml(filePath, bytes, label);

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new PolicyLoadError(
      {
        filePath,
        kind: 'schema',
        // Zod issue messages describe the expectation, never the received value.
        issues: parsed.error.issues.map((i) => ({
          path: i.path.map((seg) => (typeof seg === 'symbol' ? String(seg) : seg)),
          message: i.message,
        })),
      },
      label,
    );
  }
  const stem = basename(filePath, extname(filePath));
  if (parsed.data.version !== stem) {
    throw new PolicyLoadError(
      {
        filePath,
        kind: 'schema',
        issues: [{ path: ['version'], message: `version must match the file name "${stem}"` }],
      },
      label,
    );
  }
  return { policy: parsed.data, policyVersion: parsed.data.version, policyHash };
}

/** Reads, hashes, parses and validates a leave policy file. Sync; called once at boot. */
export function loadLeavePolicy(filePath: string): LoadedLeavePolicy {
  return LoadedLeavePolicy.parse(loadPolicyFile(filePath, LeavePolicyV1, 'Leave'));
}

/** Reads, hashes, parses and validates the QA sensitive-topics policy (spec policy-qa, rule 3). */
export function loadQaPolicy(filePath: string): LoadedQaPolicy {
  return LoadedQaPolicy.parse(loadPolicyFile(filePath, QaPolicyV1, 'QA'));
}

/** Reads, hashes, parses and validates the onboarding role templates (spec onboarding, rule 1). */
export function loadOnboardingPolicy(filePath: string): LoadedOnboardingPolicy {
  return LoadedOnboardingPolicy.parse(loadPolicyFile(filePath, OnboardingPolicyV1, 'Onboarding'));
}
