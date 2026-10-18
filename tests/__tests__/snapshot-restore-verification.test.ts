/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DERIVED_INDEX_DEFINITIONS,
  DERIVED_INDEX_IDS,
  buildRestoredSnapshot,
  formatRestoreReport,
  rebuildDerivedIndexes,
  stableStringify,
  verifySnapshotRestore,
  type DerivedIndexSnapshot,
  type RestoreFindingCode,
  type RestoreSnapshot,
} from '@/lib/recovery/snapshot-verification';

const BASELINE_PATH = join(process.cwd(), 'scripts', 'fixtures', 'recovery-baseline.json');
const DOCS = readFileSync(join(process.cwd(), 'docs', 'SNAPSHOT_RESTORE_VERIFICATION.md'), 'utf-8');

function loadBaseline(): RestoreSnapshot {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as RestoreSnapshot;
}

/** The same restore data without a persisted derived index (rebuild workflow). */
function withoutIndexes(): RestoreSnapshot {
  const { derivedIndexes: _ignored, ...rest } = loadBaseline();
  void _ignored;
  return rest;
}

function bye(restored: RestoreSnapshot, indexId: string): DerivedIndexSnapshot {
  return (restored.derivedIndexes as Record<string, DerivedIndexSnapshot>)[indexId];
}

describe('Snapshot restore verification — healthy restore', () => {
  it('rebuilds every registered derived index from critical data', () => {
    const rebuilt = rebuildDerivedIndexes(withoutIndexes());
    expect(rebuilt.map((index) => index.indexId).sort()).toEqual([...DERIVED_INDEX_IDS].sort());
    for (const index of rebuilt) {
      expect(index.digest).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
      expect(index.version).toBeGreaterThan(0);
    }
  });

  it('passes for critical data and reports indexes as missing when absent', () => {
    const report = verifySnapshotRestore(withoutIndexes(), { source: 'baseline' });

    expect(report.criticalData.errorCount).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.derivedIndexes.rebuilt).toHaveLength(DERIVED_INDEX_IDS.length);
    expect(report.derivedIndexes.missing.sort()).toEqual([...DERIVED_INDEX_IDS].sort());
    expect(report.derivedIndexes.mismatched).toEqual([]);
    expect(report.findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  it('fails when derived indexes are required but absent', () => {
    const report = verifySnapshotRestore(withoutIndexes(), { requireDerivedIndexes: true });

    expect(report.ok).toBe(false);
    expect(report.repairPlan.length).toBeGreaterThan(0);
    const missing = report.findings.filter((finding) => finding.code === 'DERIVED_INDEX_MISSING');
    expect(missing).toHaveLength(DERIVED_INDEX_IDS.length);
    expect(missing.every((finding) => finding.severity === 'error' && finding.remediation.length > 0)).toBe(true);
  });

  it('verifies a rebuilt snapshot end to end', () => {
    const restored = buildRestoredSnapshot(withoutIndexes());
    const report = verifySnapshotRestore(restored, { requireDerivedIndexes: true });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.derivedIndexes.comparisons.every((comparison) => comparison.status === 'verified')).toBe(true);
    expect(report.schemaVersion).toBe('trellis.restore.v1');
  });
});

describe('Snapshot restore verification — mismatch and corruption', () => {
  it('fails loudly when a persisted index disagrees with the rebuild', () => {
    const restored = buildRestoredSnapshot(loadBaseline());
    const totals = bye(restored, 'payout-totals-by-wallet');
    const wallet = Object.keys(totals.values)[0];
    totals.values[wallet] = { ...totals.values[wallet], completedXlm: 999999 };

    const report = verifySnapshotRestore(restored, { requireDerivedIndexes: true });

    expect(report.ok).toBe(false);
    expect(report.derivedIndexes.mismatched).toContain('payout-totals-by-wallet');
    const finding = report.findings.find((entry) => entry.code === 'DERIVED_INDEX_MISMATCH');
    expect(finding).toBeDefined();
    expect(finding?.details?.differingKeys).toContain(wallet);
    expect(report.repairPlan.some((step) => /Do not cut over/i.test(step))).toBe(true);
  });

  it('rejects a malformed persisted index', () => {
    const restored = buildRestoredSnapshot(loadBaseline());
    (restored.derivedIndexes as Record<string, unknown>)['referrals-by-code'] = {
      indexId: 'something-else',
      values: {},
    };

    const report = verifySnapshotRestore(restored, { requireDerivedIndexes: true });
    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'DERIVED_INDEX_INVALID')).toBe(true);
  });

  it('blocks the restore on corrupted critical data and carries the invariant code', () => {
    const corrupted: RestoreSnapshot = {
      testCases: [
        { id: 'tc-dup', name: 'A' },
        { id: 'tc-dup', name: 'B' },
      ] as RestoreSnapshot['testCases'],
    };

    const report = verifySnapshotRestore(corrupted);

    expect(report.ok).toBe(false);
    const finding = report.findings.find((entry) => entry.code === 'CRITICAL_DATA_INVALID');
    expect(finding).toBeDefined();
    expect(finding?.details?.invariantCode).toBe('DUPLICATE_ID');
    expect(finding?.remediation.length).toBeGreaterThan(0);
  });

  it('fails on an unsupported snapshot schema version', () => {
    const report = verifySnapshotRestore({
      ...loadBaseline(),
      schemaVersion: 'trellis.restore.v99',
    });

    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'SNAPSHOT_SCHEMA_UNSUPPORTED')).toBe(true);
  });

  it('flags derived views that cannot reconcile with their sources', () => {
    const partial: RestoreSnapshot = {
      testExecutions: [{ id: 'te-1', testCaseId: 'tc-missing', status: 'completed' }] as RestoreSnapshot['testExecutions'],
    };

    const report = verifySnapshotRestore(partial);

    expect(report.ok).toBe(false);
    expect(
      report.findings.some((finding) => finding.code === 'DERIVED_VIEW_INVARIANT_VIOLATED'),
    ).toBe(true);
    expect(report.derivedIndexes.rebuilt.some((index) => index.indexId === 'test-executions-by-case')).toBe(true);
  });

  it('treats critical-data warnings as failures only under strict mode', () => {
    const belowMinimum: RestoreSnapshot = {
      payouts: [
        {
          id: 'pay-small',
          walletAddress: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
          amount: '50.00',
          status: 'completed',
          requestedAt: '2026-01-01T00:00:00.000Z',
          transactionHash: 'tx-small-1',
        },
      ] as RestoreSnapshot['payouts'],
    };

    expect(verifySnapshotRestore(belowMinimum).ok).toBe(true);

    const strict = verifySnapshotRestore(belowMinimum, { strict: true });
    expect(strict.ok).toBe(false);
    const finding = strict.findings.find((entry) => entry.code === 'CRITICAL_DATA_WARNING');
    expect(finding?.severity).toBe('error');
  });

  it('does not mutate the source snapshot when rebuilding', () => {
    const snapshot = withoutIndexes();
    const before = JSON.stringify(snapshot);
    rebuildDerivedIndexes(snapshot);
    buildRestoredSnapshot(snapshot);
    verifySnapshotRestore(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

describe('Snapshot restore verification — contract stability', () => {
  it('produces deterministic digests and stable JSON', () => {
    const a = stableStringify({ b: 1, a: [2, 3] });
    const b = stableStringify({ a: [2, 3], b: 1 });
    expect(a).toBe(b);
    expect(rebuildDerivedIndexes(withoutIndexes())).toEqual(rebuildDerivedIndexes(withoutIndexes()));
  });

  it('documents every finding code and derived index id', () => {
    const codes: RestoreFindingCode[] = [
      'SNAPSHOT_SCHEMA_UNSUPPORTED',
      'CRITICAL_DATA_INVALID',
      'CRITICAL_DATA_WARNING',
      'DERIVED_INDEX_MISSING',
      'DERIVED_INDEX_INVALID',
      'DERIVED_INDEX_MISMATCH',
      'DERIVED_VIEW_INVARIANT_VIOLATED',
    ];
    for (const code of codes) {
      expect(DOCS).toContain(`\`${code}\``);
    }
    for (const definition of DERIVED_INDEX_DEFINITIONS) {
      expect(DOCS).toContain(`\`${definition.id}\``);
    }
  });

  it('renders a report with repair steps on failure', () => {
    const report = verifySnapshotRestore(withoutIndexes(), { requireDerivedIndexes: true });
    const text = formatRestoreReport(report);
    expect(text).toContain('FAILED');
    expect(text).toContain('repair step');
    expect(text).toContain('payout-totals-by-wallet');
  });
});
