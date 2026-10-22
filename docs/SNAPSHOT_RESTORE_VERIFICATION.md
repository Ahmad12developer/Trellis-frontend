# Snapshot Restore Verification

A restore is not complete when the rows land. The critical collections can be
internally valid while the **derived indexes** built from them — referral-code
ownership, payout totals, referral counts, execution rollups — are missing,
stale, or point at records that did not come back. Serving from that state
produces wrong dashboards and wrong payouts.

`lib/recovery/snapshot-verification.ts` verifies both halves in one run and
fails loudly with a repair plan when they disagree. It is read-only; building a
corrected snapshot is a separate, explicit step.

---

## Quick start

```bash
# Verify the bundled restore baseline
npm run restore:verify

# Verify a real snapshot as JSON for CI
npm run restore:verify -- --file /var/data/restore.json --json

# Rebuild derived indexes into a new snapshot, then verify the written file
npm run restore:verify -- --file restore.json --output restore.rebuilt.json

# Rebuild only (prints the derived indexes and exits)
npm run restore:verify -- --file restore.json --rebuild

# Rebuild workflow: do not fail just because indexes were absent
npm run restore:verify -- --file restore.json --allow-missing-derived
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Critical data is valid and derived indexes reconcile |
| `1`  | Verification failed; repair steps are printed |
| `2`  | Usage error, or the snapshot could not be read or parsed |

`2` is deliberately distinct from `1`: a missing or malformed file is an
operator mistake, not data corruption, and the two must not be confused in
CI dashboards.

---

## What is verified

### 1. Critical data invariants

The snapshot runs through `validateDomainInvariants` from
`lib/domain-invariants.ts`: uniqueness, relational integrity, settlement and
financial rules, schema/enum conformity, and chronology. Error-level
violations block the restore; warnings are reported and only block with
`--strict`.

### 2. Derived index rebuild

Every derived index is rebuilt from the restored critical data. The rebuild
always happens, whether or not the snapshot carried a persisted copy, so the
report tells you what the correct index should be.

| Index | Derived from | Contents |
|-------|--------------|----------|
| `referral-code-owners` | `referralCodes` | code → owner wallet |
| `payout-totals-by-wallet` | `payouts` | wallet → completed / reserved / failed / total XLM and payout count |
| `referrals-by-code` | `referrals` | code → total / converted / other and credited commission |
| `test-executions-by-case` | `testExecutions`, `testCases` | test case → total / completed / failed / active and average quality score |

Index contract versions are part of the persisted payload. A version change
that alters the shape requires a rebuilt index; the verifier reports the
mismatch instead of silently accepting it.

### 3. Reconciliation

When `derivedIndexes["<id>"]` is present in the snapshot, its `values` are
hashed with a stable digest and compared to the rebuild. Verified, missing,
malformed, and stale indexes are all distinguishable in the report.

### 4. Derived-view self-checks

Each rebuilt index is reconciled against its sources: counts must add up to
the collection length, totals must be finite and non-negative, and foreign
keys must resolve to restored records. A buggy rebuild cannot pass by matching
a similarly buggy persisted copy.

---

## Finding codes

| Code | Severity | Meaning | Repair |
|------|----------|---------|--------|
| `SNAPSHOT_SCHEMA_UNSUPPORTED` | error | Snapshot declares a schema version this verifier does not understand | Re-export as `trellis.restore.v1` or run the matching verifier |
| `CRITICAL_DATA_INVALID` | error | A domain invariant violation was found in the restored data | Follow the invariant's remediation, then re-run |
| `CRITICAL_DATA_WARNING` | warning | A non-blocking invariant warning (for example a sub-minimum payout) | Review; fails only with `--strict` |
| `DERIVED_INDEX_MISSING` | error with `--require-derived`, otherwise warning | The snapshot has no persisted copy of the index | Rebuild with `--output`, then verify the new snapshot |
| `DERIVED_INDEX_INVALID` | error | The persisted index is malformed or belongs to another index id | Rebuild from critical data and re-verify |
| `DERIVED_INDEX_MISMATCH` | error | The persisted index disagrees with a rebuild | Do not cut over; rebuild, diff the reported keys, re-verify |
| `DERIVED_VIEW_INVARIANT_VIOLATED` | error | A rebuilt index fails reconciliation with its sources | Fix the source collection, then rebuild |

Every finding carries a non-empty `remediation`, and the report's `repairPlan`
deduplicates them in order. A failure without a next step cannot be produced.

---

## Operational edge cases & failure modes

| Situation | Behavior | Operator action |
|-----------|----------|-----------------|
| Only critical tables were restored, no derived indexes | `DERIVED_INDEX_MISSING` warnings by default; errors with `--require-derived` | Rebuild with `--output`, then gate cutover on `--require-derived` |
| Derived index is stale because an incremental worker did not run | `DERIVED_INDEX_MISMATCH` error with differing keys | Freeze index writers, rebuild, then resume |
| A collection was partially restored (payouts present, test cases absent) | `CRITICAL_DATA_INVALID` (`ORPHANED_RECORD`) and `DERIVED_VIEW_INVARIANT_VIOLATED` | Re-run the restore for the missing collection; do not patch rows by hand |
| Snapshot was produced by a newer exporter | `SNAPSHOT_SCHEMA_UNSUPPORTED` error | Upgrade the verifier or re-export; never skip the check |
| Empty snapshot (`{}`) | Every collection scans zero records — a vacuous pass | Treat an all-zero scan as "failed to load", not "clean" |
| Duplicate referral codes | `CRITICAL_DATA_INVALID` (`DUPLICATE_ID`) and index count mismatch | Deduplicate in the source, then restore again |

The verifier treats snapshots as untrusted: non-array collections are empty,
non-object members are dropped, and malformed derived indexes become
`DERIVED_INDEX_INVALID` rather than crashing the run that is meant to diagnose
them.

---

## Recovery & rollback

1. **Stop.** Do not cut traffic over to a failing restore.
2. **Read the repair plan.** Each step names the index or invariant to fix.
3. **Rebuild derived views** (safe, idempotent, preserves critical data):
   ```bash
   npm run restore:verify -- --file restore.json --output restore.rebuilt.json
   ```
   The command writes a new file; it never overwrites the source snapshot.
4. **Re-verify the candidate** with `--require-derived`:
   ```bash
   npm run restore:verify -- --file restore.rebuilt.json --require-derived --json
   ```
5. **Roll back** by keeping the previous known-good snapshot and its derived
   indexes. Because the verifier is read-only and rebuilding is a pure
   function of critical data, the previous snapshot remains a valid rollback
   target until the new one passes.
6. **Escalate** per [`docs/DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md) when
   critical data is invalid. `DERIVED_INDEX_MISMATCH` on funds data is a
   financial-integrity incident, not a cache problem.

Rollback of this feature itself is a revert of
`lib/recovery/snapshot-verification.ts`, the CLI, and the `restore:verify`
script entry. The module adds no schema to critical data: snapshots without
`derivedIndexes` keep working, which is why the `--allow-missing-derived`
rebuild path exists.

---

## Relationship to the other verifiers

| | `restore:verify` | `validate:invariants` | `monitor:invariants` |
|---|---|---|---|
| Purpose | Verify a restore and its derived indexes | Validate a restore's critical data | Continuous drift detection |
| Module | `lib/recovery/snapshot-verification.ts` | `scripts/validate-domain-invariants.mjs` | `lib/invariant-monitor/` |
| Derived indexes | Rebuilds and reconciles | No | No |
| Runs in CI | Yes | No | Yes |

`restore:verify` calls the same invariant engine as `validate:invariants`, so
the two cannot disagree about what "valid" means for critical data. Use
`validate:invariants` for a fast data-only check and `restore:verify` before
cutover.

---

## Tests

`tests/__tests__/snapshot-restore-verification.test.ts` covers:

- a healthy snapshot with persisted indexes passes with `--require-derived`;
- a snapshot without indexes reports `DERIVED_INDEX_MISSING` and fails when
  indexes are required;
- a tampered index fails with `DERIVED_INDEX_MISMATCH` and names the differing
  keys;
- a malformed index fails with `DERIVED_INDEX_INVALID`;
- corrupted critical data fails with `CRITICAL_DATA_INVALID` carrying the
  underlying invariant code;
- an unsupported schema version fails with `SNAPSHOT_SCHEMA_UNSUPPORTED`;
- rebuilding never mutates the input snapshot;
- the finding codes documented above cover every code the module can emit.

---

## Related documents

- [`docs/DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md) — restore-time escalation
- [`docs/INVARIANT_MONITORING.md`](./INVARIANT_MONITORING.md) — continuous invariant monitoring
- [`docs/domain-integrity.md`](./domain-integrity.md) — integrity rules
- [`docs/incident-runbook.md`](./incident-runbook.md) — incident escalation
