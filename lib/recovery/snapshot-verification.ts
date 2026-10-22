/**
 * Snapshot Restore Verification — Issue #273
 *
 * A restore is not "done" when the rows land: the derived indexes that read
 * models are built from must also come back, and they must agree with the
 * critical data they were derived from. This module verifies both halves of
 * that guarantee and fails loudly with a repair plan when they disagree.
 *
 * Pipeline:
 *   1. CRITICAL DATA — run the domain invariant validator over the restored
 *      snapshot. Any error-level violation blocks the restore.
 *   2. DERIVED VIEWS  — rebuild every derived index from the restored critical
 *      data. The rebuilt values are always produced, whether or not the
 *      snapshot carried a persisted copy.
 *   3. RECONCILIATION — when the snapshot carries a persisted derived index,
 *      compare it to the rebuild by a stable digest. Missing, malformed, or
 *      stale indexes become findings with an explicit repair step.
 *   4. SELF-CHECKS    — reconcile each rebuilt index against its source
 *      collection (counts, totals, foreign keys) so a buggy rebuild cannot
 *      pass silently.
 *
 * The verifier is read-only. `buildRestoredSnapshot` produces a new snapshot
 * with rebuilt indexes; it never mutates its input.
 */

import {
  validateDomainInvariants,
  type DomainDataset,
  type InvariantViolation,
} from '@/lib/domain-invariants';

// ─── Snapshot shape ──────────────────────────────────────────────────────────

/** Snapshot schema version the verifier understands. */
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS = ['trellis.restore.v1'] as const;

export type SupportedSnapshotSchemaVersion = (typeof SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS)[number];

/**
 * A restore snapshot: the critical domain collections plus an optional
 * persisted copy of each derived index. `domain-invariants` snapshots replay
 * unchanged — the extra keys are ignored by the validator.
 */
export interface RestoreSnapshot extends DomainDataset {
  schemaVersion?: string;
  derivedIndexes?: Record<string, unknown>;
}

// ─── Findings ────────────────────────────────────────────────────────────────

export type RestoreFindingCode =
  | 'SNAPSHOT_SCHEMA_UNSUPPORTED'
  | 'CRITICAL_DATA_INVALID'
  | 'CRITICAL_DATA_WARNING'
  | 'DERIVED_INDEX_MISSING'
  | 'DERIVED_INDEX_INVALID'
  | 'DERIVED_INDEX_MISMATCH'
  | 'DERIVED_VIEW_INVARIANT_VIOLATED';

export interface RestoreFinding {
  code: RestoreFindingCode;
  severity: 'error' | 'warning';
  message: string;
  /** Safe next step for a maintainer. Never empty. */
  remediation: string;
  indexId?: DerivedIndexId;
  details?: Record<string, unknown>;
}

// ─── Derived index contracts ─────────────────────────────────────────────────

export type DerivedIndexId =
  | 'referral-code-owners'
  | 'payout-totals-by-wallet'
  | 'referrals-by-code'
  | 'test-executions-by-case';

export type DerivedIndexValues = Record<string, Record<string, number | string>>;

export interface DerivedIndexSnapshot {
  indexId: DerivedIndexId;
  /** Version of the index definition, not of the data. */
  version: number;
  /** Number of critical records the index was derived from. */
  sourceCount: number;
  values: DerivedIndexValues;
  /** Stable digest of `values`, used for reconciliation. */
  digest: string;
}

export interface DerivedIndexDefinition {
  id: DerivedIndexId;
  version: number;
  title: string;
  description: string;
  criticalSources: readonly string[];
  rebuild(dataset: RestoreSnapshot): { sourceCount: number; values: DerivedIndexValues };
  reconcile(dataset: RestoreSnapshot, values: DerivedIndexValues): DerivedViewIssue[];
}

export interface DerivedViewIssue {
  message: string;
  remediation: string;
  details?: Record<string, unknown>;
}

// ─── Comparison results ──────────────────────────────────────────────────────

export type DerivedIndexComparisonStatus = 'verified' | 'missing' | 'invalid' | 'mismatch';

export interface DerivedIndexComparison {
  indexId: DerivedIndexId;
  status: DerivedIndexComparisonStatus;
  rebuiltDigest: string;
  rebuiltVersion: number;
  expectedDigest?: string;
  expectedVersion?: number;
  differingKeys?: string[];
}

export interface SnapshotRestoreReport {
  timestamp: string;
  source: string;
  ok: boolean;
  schemaVersion?: string;
  criticalData: {
    valid: boolean;
    totalChecks: number;
    errorCount: number;
    warningCount: number;
    violations: InvariantViolation[];
  };
  derivedIndexes: {
    rebuilt: DerivedIndexSnapshot[];
    comparisons: DerivedIndexComparison[];
    missing: DerivedIndexId[];
    mismatched: DerivedIndexId[];
  };
  findings: RestoreFinding[];
  /** Deduplicated, ordered remediations for every error-level finding. */
  repairPlan: string[];
}

export interface RestoreVerificationOptions {
  source?: string;
  /**
   * Fail when the snapshot does not carry a persisted copy of a derived index.
   * Leave false while rebuilding after a base restore; set true before
   * cutover so an incomplete snapshot cannot go live.
   */
  requireDerivedIndexes?: boolean;
  /** Treat critical-data warnings (e.g. sub-minimum payouts) as failures. */
  strict?: boolean;
}

// ─── Stable serialization & digest ───────────────────────────────────────────

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = canonicalize(source[key]);
    }
    return result;
  }
  return value;
}

/** Deterministic JSON with sorted object keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Stable, dependency-free digest of a derived index payload. */
export function digestValue(value: unknown): string {
  return `fnv1a32:${fnv1a32(stableStringify(value))}`;
}

// ─── Untrusted readers ───────────────────────────────────────────────────────

function readArray<T = Record<string, unknown>>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is T => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function recordsOf<K extends keyof DomainDataset>(dataset: RestoreSnapshot, key: K): Record<string, unknown>[] {
  return readArray(dataset[key]);
}

// ─── Derived index definitions ───────────────────────────────────────────────

const referralCodeOwners: DerivedIndexDefinition = {
  id: 'referral-code-owners',
  version: 1,
  title: 'Referral code owners',
  description: 'Maps every referral code to the wallet that owns it.',
  criticalSources: ['referralCodes'],
  rebuild(dataset) {
    const codes = recordsOf(dataset, 'referralCodes');
    const values: DerivedIndexValues = {};
    for (const record of codes) {
      const code = readString(record, 'code');
      if (!code) continue;
      values[code] = { ownerWallet: readString(record, 'ownerWallet') ?? '' };
    }
    return { sourceCount: codes.length, values };
  },
  reconcile(dataset, values) {
    const issues: DerivedViewIssue[] = [];
    const codes = recordsOf(dataset, 'referralCodes');
    const uniqueCodes = new Set(
      codes.map((record) => readString(record, 'code')).filter((code): code is string => !!code),
    );
    if (Object.keys(values).length !== uniqueCodes.size) {
      issues.push({
        message: `Derived index has ${Object.keys(values).length} code(s) but the snapshot has ${uniqueCodes.size} unique code(s).`,
        remediation: 'Rebuild the referral-code-owners index after resolving duplicate or empty referral codes.',
      });
    }
    for (const [code, value] of Object.entries(values)) {
      if (!value.ownerWallet || String(value.ownerWallet).trim() === '') {
        issues.push({
          message: `Referral code '${code}' resolves to an empty owner wallet.`,
          remediation: `Restore the owner wallet for referral code '${code}' before cutover.`,
          details: { code },
        });
      }
    }
    return issues;
  },
};

const payoutTotalsByWallet: DerivedIndexDefinition = {
  id: 'payout-totals-by-wallet',
  version: 1,
  title: 'Payout totals by wallet',
  description: 'Aggregates completed, in-flight, and failed payout totals per wallet.',
  criticalSources: ['payouts'],
  rebuild(dataset) {
    const payouts = recordsOf(dataset, 'payouts');
    const values: DerivedIndexValues = {};
    for (const payout of payouts) {
      const wallet = readString(payout, 'walletAddress');
      if (!wallet) continue;
      const amount = readNumber(payout, 'amount') ?? 0;
      const status = readString(payout, 'status') ?? 'pending';
      const bucket = (values[wallet] ??= {
        count: 0,
        completedXlm: 0,
        reservedXlm: 0,
        failedXlm: 0,
        totalXlm: 0,
      });
      bucket.count = Number(bucket.count) + 1;
      bucket.totalXlm = round(Number(bucket.totalXlm) + amount);
      if (status === 'completed') {
        bucket.completedXlm = round(Number(bucket.completedXlm) + amount);
      } else if (status === 'pending' || status === 'processing') {
        bucket.reservedXlm = round(Number(bucket.reservedXlm) + amount);
      } else if (status === 'failed') {
        bucket.failedXlm = round(Number(bucket.failedXlm) + amount);
      }
    }
    return { sourceCount: payouts.length, values };
  },
  reconcile(dataset, values) {
    const issues: DerivedViewIssue[] = [];
    const payouts = recordsOf(dataset, 'payouts');
    let indexedCount = 0;
    for (const [wallet, value] of Object.entries(values)) {
      if (wallet.trim() === '') {
        issues.push({
          message: 'Derived payout index contains an empty wallet key.',
          remediation: 'Rebuild the payout-totals-by-wallet index after fixing payouts with missing wallet addresses.',
        });
      }
      for (const field of ['count', 'completedXlm', 'reservedXlm', 'failedXlm', 'totalXlm']) {
        const amount = Number(value[field] ?? 0);
        if (!Number.isFinite(amount) || amount < 0) {
          issues.push({
            message: `Derived payout total '${field}' for wallet '${wallet}' is not a finite non-negative number.`,
            remediation: 'Rebuild the payout-totals-by-wallet index and inspect the payout amounts it aggregated.',
            details: { wallet, field },
          });
        }
      }
      indexedCount += Number(value.count ?? 0);
    }
    if (indexedCount !== payouts.length) {
      issues.push({
        message: `Derived payout index indexed ${indexedCount} payout(s) but the snapshot has ${payouts.length}.`,
        remediation: 'Rebuild the payout-totals-by-wallet index; a partially restored payout collection cannot reconcile.',
      });
    }
    return issues;
  },
};

const referralsByCode: DerivedIndexDefinition = {
  id: 'referrals-by-code',
  version: 1,
  title: 'Referrals by code',
  description: 'Counts referrals and credited commission per referral code.',
  criticalSources: ['referrals'],
  rebuild(dataset) {
    const referrals = recordsOf(dataset, 'referrals');
    const values: DerivedIndexValues = {};
    for (const referral of referrals) {
      const code = readString(referral, 'referralCode');
      if (!code) continue;
      const amount = readNumber(referral, 'commissionAmount') ?? 0;
      const status = readString(referral, 'status') ?? 'active';
      const bucket = (values[code] ??= {
        total: 0,
        converted: 0,
        other: 0,
        commissionXlm: 0,
      });
      bucket.total = Number(bucket.total) + 1;
      if (status === 'converted') bucket.converted = Number(bucket.converted) + 1;
      else bucket.other = Number(bucket.other) + 1;
      bucket.commissionXlm = round(Number(bucket.commissionXlm) + amount);
    }
    return { sourceCount: referrals.length, values };
  },
  reconcile(dataset, values) {
    const issues: DerivedViewIssue[] = [];
    const referrals = recordsOf(dataset, 'referrals');
    let indexed = 0;
    let converted = 0;
    for (const value of Object.values(values)) {
      indexed += Number(value.total ?? 0);
      converted += Number(value.converted ?? 0);
    }
    const convertedSource = referrals.filter(
      (referral) => readString(referral, 'status') === 'converted',
    ).length;
    if (indexed !== referrals.length) {
      issues.push({
        message: `Derived referral index counted ${indexed} referral(s) but the snapshot has ${referrals.length}.`,
        remediation: 'Rebuild the referrals-by-code index; check for referrals with a missing referral code.',
      });
    }
    if (converted !== convertedSource) {
      issues.push({
        message: `Derived referral index counted ${converted} converted referral(s) but the snapshot has ${convertedSource}.`,
        remediation: 'Rebuild the referrals-by-code index; an inconsistent conversion count means the index is stale.',
      });
    }
    return issues;
  },
};

const testExecutionsByCase: DerivedIndexDefinition = {
  id: 'test-executions-by-case',
  version: 1,
  title: 'Test executions by case',
  description: 'Counts executions and averages quality scores per test case.',
  criticalSources: ['testExecutions', 'testCases'],
  rebuild(dataset) {
    const executions = recordsOf(dataset, 'testExecutions');
    const values: DerivedIndexValues = {};
    for (const execution of executions) {
      const testCaseId = readString(execution, 'testCaseId');
      if (!testCaseId) continue;
      const status = readString(execution, 'status') ?? 'pending';
      const score = readNumber(execution, 'qualityScore');
      const bucket = (values[testCaseId] ??= {
        total: 0,
        completed: 0,
        failed: 0,
        active: 0,
        qualityScoreSum: 0,
        qualityScoreCount: 0,
        averageQualityScore: 0,
      });
      bucket.total = Number(bucket.total) + 1;
      if (status === 'completed') bucket.completed = Number(bucket.completed) + 1;
      else if (status === 'failed') bucket.failed = Number(bucket.failed) + 1;
      else bucket.active = Number(bucket.active) + 1;
      if (score !== null) {
        bucket.qualityScoreSum = round(Number(bucket.qualityScoreSum) + score, 4);
        bucket.qualityScoreCount = Number(bucket.qualityScoreCount) + 1;
      }
    }
    for (const value of Object.values(values)) {
      const count = Number(value.qualityScoreCount ?? 0);
      value.averageQualityScore = count > 0 ? round(Number(value.qualityScoreSum) / count, 2) : 0;
      delete value.qualityScoreSum;
      delete value.qualityScoreCount;
    }
    return { sourceCount: executions.length, values };
  },
  reconcile(dataset, values) {
    const issues: DerivedViewIssue[] = [];
    const executions = recordsOf(dataset, 'testExecutions');
    const testCases = recordsOf(dataset, 'testCases');
    const knownCaseIds = new Set(
      testCases.map((testCase) => readString(testCase, 'id')).filter((id): id is string => !!id),
    );
    let indexed = 0;
    for (const [testCaseId, value] of Object.entries(values)) {
      indexed += Number(value.total ?? 0);
      if (knownCaseIds.size > 0 && !knownCaseIds.has(testCaseId)) {
        issues.push({
          message: `Derived execution index references unknown test case '${testCaseId}'.`,
          remediation: `Restore test case '${testCaseId}' or rebuild the test-executions-by-case index after purging orphaned executions.`,
          details: { testCaseId },
        });
      }
    }
    if (indexed !== executions.length) {
      issues.push({
        message: `Derived execution index counted ${indexed} execution(s) but the snapshot has ${executions.length}.`,
        remediation: 'Rebuild the test-executions-by-case index; check for executions with a missing testCaseId.',
      });
    }
    if (executions.length > 0 && knownCaseIds.size === 0) {
      issues.push({
        message: 'Snapshot contains test executions but no test cases to resolve them against.',
        remediation: 'Restore the test case collection before verifying derived execution indexes.',
      });
    }
    return issues;
  },
};

export const DERIVED_INDEX_DEFINITIONS: readonly DerivedIndexDefinition[] = [
  referralCodeOwners,
  payoutTotalsByWallet,
  referralsByCode,
  testExecutionsByCase,
];

export const DERIVED_INDEX_IDS: readonly DerivedIndexId[] = DERIVED_INDEX_DEFINITIONS.map(
  (definition) => definition.id,
);

function definitionFor(indexId: string): DerivedIndexDefinition | undefined {
  return DERIVED_INDEX_DEFINITIONS.find((definition) => definition.id === indexId);
}

// ─── Rebuild ─────────────────────────────────────────────────────────────────

/**
 * Rebuild every derived index from the snapshot's critical data. Always runs
 * the whole set, so a caller can materialize a base restore without first
 * having a persisted index to compare against.
 */
export function rebuildDerivedIndexes(snapshot: RestoreSnapshot): DerivedIndexSnapshot[] {
  return DERIVED_INDEX_DEFINITIONS.map((definition) => {
    const { sourceCount, values } = definition.rebuild(snapshot);
    return {
      indexId: definition.id,
      version: definition.version,
      sourceCount,
      values,
      digest: digestValue(values),
    };
  });
}

/**
 * Produce a new snapshot with rebuilt derived indexes. Read-only with respect
 * to the input; the caller decides where to persist the result.
 */
export function buildRestoredSnapshot(
  snapshot: RestoreSnapshot,
  rebuilt: DerivedIndexSnapshot[] = rebuildDerivedIndexes(snapshot),
): RestoreSnapshot {
  const derivedIndexes: Record<string, DerivedIndexSnapshot> = {};
  for (const index of rebuilt) {
    derivedIndexes[index.indexId] = index;
  }
  return {
    ...snapshot,
    schemaVersion: snapshot.schemaVersion ?? SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS[0],
    derivedIndexes,
  };
}

// ─── Verification ────────────────────────────────────────────────────────────

function differingKeys(expected: unknown, actual: unknown): string[] {
  const expectedRecord =
    expected !== null && typeof expected === 'object' ? (expected as Record<string, unknown>) : {};
  const actualRecord =
    actual !== null && typeof actual === 'object' ? (actual as Record<string, unknown>) : {};
  const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]);
  return [...keys]
    .filter((key) => stableStringify(expectedRecord[key]) !== stableStringify(actualRecord[key]))
    .sort()
    .slice(0, 20);
}

function comparePersistedIndex(
  definition: DerivedIndexDefinition,
  rebuilt: DerivedIndexSnapshot,
  persisted: unknown,
  requireDerivedIndexes: boolean,
): { comparison: DerivedIndexComparison; finding?: RestoreFinding } {
  if (persisted === undefined || persisted === null) {
    return {
      comparison: {
        indexId: definition.id,
        status: 'missing',
        rebuiltDigest: rebuilt.digest,
        rebuiltVersion: rebuilt.version,
      },
      finding: {
        code: 'DERIVED_INDEX_MISSING',
        severity: requireDerivedIndexes ? 'error' : 'warning',
        indexId: definition.id,
        message: `Snapshot does not carry '${definition.id}'.`,
        remediation: `Rebuild it with 'npm run restore:verify -- --output <new-snapshot.json>', then re-run with --require-derived before cutover.`,
      },
    };
  }

  const record =
    typeof persisted === 'object' && persisted !== null
      ? (persisted as Record<string, unknown>)
      : {};
  const version = typeof record.version === 'number' ? record.version : undefined;
  const values =
    typeof record.values === 'object' && record.values !== null
      ? (record.values as DerivedIndexValues)
      : undefined;

  if (!values || record.indexId !== definition.id) {
    return {
      comparison: {
        indexId: definition.id,
        status: 'invalid',
        rebuiltDigest: rebuilt.digest,
        rebuiltVersion: rebuilt.version,
        expectedVersion: version,
      },
      finding: {
        code: 'DERIVED_INDEX_INVALID',
        severity: 'error',
        indexId: definition.id,
        message: `Persisted '${definition.id}' is malformed (expected an object with indexId '${definition.id}' and a values map).`,
        remediation: `Rebuild '${definition.id}' from critical data with 'npm run restore:verify -- --output <new-snapshot.json>', then re-verify.`,
      },
    };
  }

  const expectedDigest = digestValue(values);
  const expectedVersion = version;
  const versionMatches = expectedVersion === rebuilt.version;

  if (expectedDigest === rebuilt.digest && versionMatches) {
    return {
      comparison: {
        indexId: definition.id,
        status: 'verified',
        rebuiltDigest: rebuilt.digest,
        rebuiltVersion: rebuilt.version,
        expectedDigest,
        expectedVersion,
      },
    };
  }

  const mismatches = differingKeys(values, rebuilt.values);
  const versionNote = versionMatches
    ? ''
    : ` (index version ${String(expectedVersion)} != ${rebuilt.version})`;

  return {
    comparison: {
      indexId: definition.id,
      status: 'mismatch',
      rebuiltDigest: rebuilt.digest,
      rebuiltVersion: rebuilt.version,
      expectedDigest,
      expectedVersion,
      differingKeys: mismatches,
    },
    finding: {
      code: 'DERIVED_INDEX_MISMATCH',
      severity: 'error',
      indexId: definition.id,
      message: `Persisted '${definition.id}' disagrees with a rebuild from restored critical data${versionNote}.`,
      remediation: `Do not cut over. Rebuild '${definition.id}' from critical data with 'npm run restore:verify -- --output <new-snapshot.json>', diff the differing keys, and re-verify.`,
      details: { differingKeys: mismatches, expectedDigest, rebuiltDigest: rebuilt.digest },
    },
  };
}

/**
 * Verify a restore snapshot.
 *
 * `ok` is true only when critical data has no error-level violations, every
 * persisted derived index matches its rebuild, and every rebuilt index passes
 * its reconciliation self-checks. Warnings (including missing indexes unless
 * `requireDerivedIndexes` is set) are reported but do not block on their own.
 */
export function verifySnapshotRestore(
  snapshot: RestoreSnapshot = {},
  options: RestoreVerificationOptions = {},
): SnapshotRestoreReport {
  const source = options.source ?? 'snapshot';
  const findings: RestoreFinding[] = [];

  // 1. Critical data invariants.
  const invariantReport = validateDomainInvariants(snapshot, { strict: options.strict });
  for (const violation of invariantReport.violations) {
    const isError = violation.severity === 'error' || Boolean(options.strict);
    findings.push({
      code: violation.severity === 'error' ? 'CRITICAL_DATA_INVALID' : 'CRITICAL_DATA_WARNING',
      severity: isError ? 'error' : 'warning',
      message: `[${violation.code}] ${violation.entityType}#${violation.entityId}: ${violation.message}`,
      remediation: violation.remediation,
      details: { invariantCode: violation.code, entityType: violation.entityType, entityId: violation.entityId },
    });
  }

  // 2. Schema version compatibility.
  const schemaVersion = typeof snapshot.schemaVersion === 'string' ? snapshot.schemaVersion : undefined;
  if (
    schemaVersion &&
    !SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS.includes(schemaVersion as SupportedSnapshotSchemaVersion)
  ) {
    findings.push({
      code: 'SNAPSHOT_SCHEMA_UNSUPPORTED',
      severity: 'error',
      message: `Snapshot schema '${schemaVersion}' is not supported by this verifier.`,
      remediation: `Re-export the snapshot as '${SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS[0]}' or run the verifier version that supports '${schemaVersion}'. Do not cut over.`,
    });
  }

  // 3. Rebuild and reconcile derived indexes.
  const rebuilt = rebuildDerivedIndexes(snapshot);
  const persisted =
    snapshot.derivedIndexes && typeof snapshot.derivedIndexes === 'object'
      ? snapshot.derivedIndexes
      : {};
  const comparisons: DerivedIndexComparison[] = [];

  for (const definition of DERIVED_INDEX_DEFINITIONS) {
    const rebuiltIndex = rebuilt.find((index) => index.indexId === definition.id);
    if (!rebuiltIndex) continue;

    const { comparison, finding } = comparePersistedIndex(
      definition,
      rebuiltIndex,
      (persisted as Record<string, unknown>)[definition.id],
      options.requireDerivedIndexes ?? false,
    );
    comparisons.push(comparison);
    if (finding) findings.push(finding);

    for (const issue of definition.reconcile(snapshot, rebuiltIndex.values)) {
      findings.push({
        code: 'DERIVED_VIEW_INVARIANT_VIOLATED',
        severity: 'error',
        indexId: definition.id,
        message: `${definition.title}: ${issue.message}`,
        remediation: issue.remediation,
        details: issue.details,
      });
    }
  }

  const repairPlan: string[] = [];
  for (const finding of findings) {
    if (finding.severity !== 'error') continue;
    if (!repairPlan.includes(finding.remediation)) repairPlan.push(finding.remediation);
  }

  const derivedIndexIds = new Set(DERIVED_INDEX_IDS);
  return {
    timestamp: new Date().toISOString(),
    source,
    ok: findings.every((finding) => finding.severity !== 'error'),
    schemaVersion,
    criticalData: {
      valid: invariantReport.isValid,
      totalChecks: invariantReport.summary.totalChecks,
      errorCount: invariantReport.summary.errorCount,
      warningCount: invariantReport.summary.warningCount,
      violations: invariantReport.violations,
    },
    derivedIndexes: {
      rebuilt,
      comparisons,
      missing: comparisons
        .filter((comparison) => comparison.status === 'missing')
        .map((comparison) => comparison.indexId)
        .filter((indexId): indexId is DerivedIndexId => derivedIndexIds.has(indexId)),
      mismatched: comparisons
        .filter((comparison) => comparison.status === 'mismatch' || comparison.status === 'invalid')
        .map((comparison) => comparison.indexId)
        .filter((indexId): indexId is DerivedIndexId => derivedIndexIds.has(indexId)),
    },
    findings,
    repairPlan,
  };
}

// ─── Text rendering ──────────────────────────────────────────────────────────

const STATUS_LABEL: Record<DerivedIndexComparisonStatus, string> = {
  verified: 'VERIFIED',
  missing: 'MISSING',
  invalid: 'INVALID',
  mismatch: 'MISMATCH',
};

/** Human-readable report for a terminal or an incident channel. */
export function formatRestoreReport(report: SnapshotRestoreReport): string {
  const lines: string[] = [];
  lines.push('================================================================');
  lines.push('   Trellis — Snapshot Restore Verification');
  lines.push('================================================================');
  lines.push(`Source:    ${report.source}`);
  lines.push(`Schema:    ${report.schemaVersion ?? 'unversioned'}`);
  lines.push(`Generated: ${report.timestamp}`);
  lines.push('');
  lines.push(
    `Critical data: ${report.criticalData.valid ? 'VALID' : 'INVALID'} ` +
      `(${report.criticalData.totalChecks} checks, ${report.criticalData.errorCount} error(s), ${report.criticalData.warningCount} warning(s))`,
  );
  lines.push('');
  lines.push('Derived indexes:');
  for (const index of report.derivedIndexes.rebuilt) {
    const comparison = report.derivedIndexes.comparisons.find((entry) => entry.indexId === index.indexId);
    const status = comparison ? STATUS_LABEL[comparison.status] : 'REBUILT';
    lines.push(`  [${status}] ${index.indexId} (v${index.version}, ${index.sourceCount} source record(s))`);
  }

  if (report.findings.length > 0) {
    lines.push('');
    lines.push('Findings:');
    for (const finding of report.findings) {
      lines.push(`  [${finding.severity.toUpperCase()}] ${finding.code}${finding.indexId ? ` (${finding.indexId})` : ''}`);
      lines.push(`        ${finding.message}`);
      lines.push(`        Next step: ${finding.remediation}`);
    }
  }

  lines.push('');
  if (report.ok) {
    lines.push('Restore verification PASSED. Derived indexes reconcile with critical data.');
  } else {
    lines.push(`Restore verification FAILED with ${report.repairPlan.length} repair step(s).`);
    for (const step of report.repairPlan) lines.push(`  - ${step}`);
    lines.push('Do not cut over until this report passes with --require-derived.');
  }

  return lines.join('\n');
}
