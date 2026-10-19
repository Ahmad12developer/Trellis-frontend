#!/usr/bin/env tsx
/**
 * Trellis Snapshot Restore Verification CLI — Issue #273
 *
 * Verifies that a restored snapshot's critical data satisfies domain
 * invariants and that its derived indexes reconcile with a rebuild.
 *
 * Usage:
 *   npm run restore:verify
 *   npm run restore:verify -- --file path/to/snapshot.json --json
 *   npm run restore:verify -- --file snapshot.json --output restored.json
 *   npm run restore:verify -- --file snapshot.json --rebuild
 *
 * Exit codes:
 *   0  verification passed
 *   1  verification failed (repair steps printed)
 *   2  usage error, or the snapshot could not be read or parsed
 *
 * This command is read-only unless `--output` is supplied, in which case it
 * writes a *new* snapshot containing rebuilt derived indexes and verifies it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildRestoredSnapshot,
  formatRestoreReport,
  rebuildDerivedIndexes,
  verifySnapshotRestore,
  type RestoreSnapshot,
} from '../lib/recovery/snapshot-verification';

const DEFAULT_FILE = resolve(process.cwd(), 'scripts', 'fixtures', 'recovery-baseline.json');

interface CliOptions {
  file?: string;
  json: boolean;
  strict: boolean;
  requireDerived: boolean;
  output?: string;
  rebuild: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    strict: false,
    requireDerived: true,
    rebuild: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--allow-missing-derived') options.requireDerived = false;
    else if (arg === '--rebuild') options.rebuild = true;
    else if (arg === '--file' || arg === '-f') options.file = argv[++i];
    else if (arg === '--output' || arg === '-o') options.output = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else options.file = arg;
  }

  return options;
}

function printHelp(): void {
  console.log(`
Trellis Snapshot Restore Verification

Usage:
  npm run restore:verify [options]

Options:
  --file, -f <path>          Snapshot JSON to verify (default: recovery baseline fixture)
  --output, -o <path>        Write a new snapshot with rebuilt derived indexes, then verify it
  --rebuild                  Print rebuilt derived indexes as JSON and exit 0
  --allow-missing-derived    Do not fail when a derived index is absent (rebuild workflow)
  --strict                   Treat critical-data warnings as failures
  --json                     Emit the report as JSON
  -h, --help                 Show this help
`);
}

function loadSnapshot(path: string): RestoreSnapshot {
  if (!existsSync(path)) {
    throw new Error(`Snapshot not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to parse snapshot JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Snapshot must be a JSON object.');
  }
  return parsed as RestoreSnapshot;
}

function main(): number {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\nRun with --help for usage.`);
    return 2;
  }

  if (options.help) {
    printHelp();
    return 0;
  }

  const file = resolve(options.file ?? DEFAULT_FILE);
  let snapshot: RestoreSnapshot;
  try {
    snapshot = loadSnapshot(file);
  } catch (error) {
    console.error(`Error loading snapshot: ${(error as Error).message}`);
    return 2;
  }

  if (options.rebuild) {
    console.log(JSON.stringify(rebuildDerivedIndexes(snapshot), null, 2));
    return 0;
  }

  // `--output` materializes a candidate restore and then verifies the written
  // artifact, so the operator proof covers the bytes that will actually be used.
  if (options.output) {
    const outputPath = resolve(options.output);
    const restored = buildRestoredSnapshot(snapshot);
    writeFileSync(outputPath, `${JSON.stringify(restored, null, 2)}\n`, 'utf-8');
    if (!options.json) {
      console.log(`Wrote rebuilt snapshot: ${outputPath}`);
    }
    snapshot = restored;
  }

  const report = verifySnapshotRestore(snapshot, {
    source: file,
    strict: options.strict,
    requireDerivedIndexes: options.requireDerived || Boolean(options.output),
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatRestoreReport(report));
  }

  return report.ok ? 0 : 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error('Fatal snapshot verification error:', error instanceof Error ? error.message : error);
  process.exit(2);
}
