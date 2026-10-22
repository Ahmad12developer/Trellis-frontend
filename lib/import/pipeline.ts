import {
  EntitySchema,
  FieldValidationRule,
  ImportOptions,
  ImportResult,
  RowValidationError,
  RowValidationResult,
  SupportedEntityType,
  RollbackGuidance,
  RollbackCompensationStep,
} from './types';
import { parseCSV } from './csv-parser';

// Built-in schemas for standard Trellis entities
export const ENTITY_SCHEMAS: Record<SupportedEntityType, EntitySchema> = {
  agents: {
    entityType: 'agents',
    idField: 'id',
    fields: [
      { field: 'name', required: true, type: 'string', minLength: 2, maxLength: 100 },
      { field: 'description', required: true, type: 'string', minLength: 5, maxLength: 1000 },
      { field: 'category', required: false, type: 'string', enum: ['trading', 'governance', 'analytics', 'security', 'general'] },
      { field: 'price', required: false, type: 'number', min: 0 },
      { field: 'version', required: false, type: 'string', pattern: /^\d+\.\d+\.\d+$/ },
    ],
  },
  'test-cases': {
    entityType: 'test-cases',
    idField: 'id',
    fields: [
      { field: 'title', required: true, type: 'string', minLength: 3, maxLength: 150 },
      { field: 'agentId', required: true, type: 'string', minLength: 1 },
      { field: 'type', required: true, type: 'string', enum: ['unit', 'integration', 'fuzz', 'performance'] },
      { field: 'input', required: true },
      { field: 'expectedOutput', required: true },
    ],
  },
  provenance: {
    entityType: 'provenance',
    idField: 'id',
    fields: [
      { field: 'agentId', required: true, type: 'string' },
      { field: 'agentName', required: true, type: 'string' },
      { field: 'userId', required: true, type: 'string' },
      { field: 'action', required: true, type: 'string' },
      { field: 'timestamp', required: true, type: 'string' },
      { field: 'status', required: true, enum: ['success', 'failed', 'pending'] },
    ],
  },
  submissions: {
    entityType: 'submissions',
    idField: 'id',
    fields: [
      { field: 'agentName', required: true, type: 'string', minLength: 2 },
      { field: 'creator', required: true, type: 'string' },
      { field: 'status', required: false, enum: ['pending', 'approved', 'rejected', 'in_review'] },
      { field: 'contractAddress', required: false, type: 'string' },
    ],
  },
  general: {
    entityType: 'general',
    idField: 'id',
    fields: [
      { field: 'id', required: false, type: 'string' },
    ],
  },
};

/**
 * Validate a single row against an entity schema.
 */
export function validateRow(
  row: Record<string, any>,
  schema: EntitySchema,
  rowNumber: number
): { valid: boolean; errors: RowValidationError[] } {
  const errors: RowValidationError[] = [];

  for (const rule of schema.fields) {
    const val = row[rule.field];

    if (rule.required && (val === undefined || val === null || val === '')) {
      errors.push({
        field: rule.field,
        message: `Field '${rule.field}' is required`,
        value: val,
      });
      continue;
    }

    if (val !== undefined && val !== null && val !== '') {
      if (rule.type) {
        const actualType = Array.isArray(val) ? 'array' : typeof val;
        if (rule.type === 'number' && typeof val !== 'number') {
          errors.push({
            field: rule.field,
            message: `Field '${rule.field}' must be a number, got ${typeof val}`,
            value: val,
          });
        } else if (rule.type === 'string' && typeof val !== 'string') {
          errors.push({
            field: rule.field,
            message: `Field '${rule.field}' must be a string, got ${typeof val}`,
            value: val,
          });
        } else if (rule.type === 'boolean' && typeof val !== 'boolean') {
          errors.push({
            field: rule.field,
            message: `Field '${rule.field}' must be a boolean`,
            value: val,
          });
        }
      }

      if (typeof val === 'string') {
        if (rule.minLength !== undefined && val.length < rule.minLength) {
          errors.push({
            field: rule.field,
            message: `Field '${rule.field}' must have at least ${rule.minLength} characters`,
            value: val,
          });
        }
        if (rule.maxLength !== undefined && val.length > rule.maxLength) {
          errors.push({
            field: rule.field,
            message: `Field '${rule.field}' cannot exceed ${rule.maxLength} characters`,
            value: val,
          });
        }
        if (rule.pattern && !rule.pattern.test(val)) {
          errors.push({
            field: rule.field,
            message: `Field '${rule.field}' has invalid format`,
            value: val,
          });
        }
      }

      if (typeof val === 'number') {
        if (rule.min !== undefined && val < rule.min) {
          errors.push({
            field: rule.field,
            message: `Field '${rule.field}' must be at least ${rule.min}`,
            value: val,
          });
        }
        if (rule.max !== undefined && val > rule.max) {
          errors.push({
            field: rule.field,
            message: `Field '${rule.field}' cannot exceed ${rule.max}`,
            value: val,
          });
        }
      }

      if (rule.enum && !rule.enum.includes(String(val))) {
        errors.push({
          field: rule.field,
          message: `Field '${rule.field}' must be one of: ${rule.enum.join(', ')}`,
          value: val,
        });
      }

      if (rule.customValidator) {
        const customErr = rule.customValidator(val, row);
        if (customErr) {
          errors.push({
            field: rule.field,
            message: customErr,
            value: val,
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * In-memory state store for managing persistent imports in frontend / mock backend.
 */
class ImportStateStore {
  private stores: Map<string, Map<string, Record<string, any>>> = new Map();
  private snapshots: Map<string, { entityType: string; records: Map<string, Record<string, any>> }> = new Map();

  getStore(entityType: string): Map<string, Record<string, any>> {
    if (!this.stores.has(entityType)) {
      this.stores.set(entityType, new Map());
    }
    return this.stores.get(entityType)!;
  }

  createSnapshot(entityType: string): string {
    const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const store = this.getStore(entityType);
    const copy = new Map<string, Record<string, any>>();
    store.forEach((val, key) => copy.set(key, JSON.parse(JSON.stringify(val))));
    this.snapshots.set(snapshotId, { entityType, records: copy });
    return snapshotId;
  }

  restoreSnapshot(snapshotId: string): boolean {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) return false;
    this.stores.set(snap.entityType, snap.records);
    return true;
  }

  getExisting(entityType: string, id: string): Record<string, any> | undefined {
    return this.getStore(entityType).get(id);
  }

  set(entityType: string, id: string, data: Record<string, any>): void {
    this.getStore(entityType).set(id, JSON.parse(JSON.stringify(data)));
  }

  delete(entityType: string, id: string): void {
    this.getStore(entityType).delete(id);
  }

  getAll(entityType: string): Record<string, any>[] {
    return Array.from(this.getStore(entityType).values());
  }

  clear(entityType: string): void {
    this.getStore(entityType).clear();
  }
}

export const importStore = new ImportStateStore();

/**
 * Execute the import pipeline with dry-run support, idempotency, duplicate detection, and rollback guidance.
 */
export function runImportPipeline(
  input: string | Record<string, any>[],
  options: ImportOptions = {},
  customSchema?: EntitySchema
): ImportResult {
  const entityType = options.entityType || 'general';
  const schema = customSchema || ENTITY_SCHEMAS[entityType] || ENTITY_SCHEMAS.general;
  const isDryRun = options.dryRun !== false; // default to dryRun = true for safety
  const idempotent = options.idempotent !== false; // default to idempotent
  const allowUpdate = options.allowUpdate !== false; // default to allowUpdate
  const stopOnError = options.stopOnError === true;
  const idKey = options.externalIdKey || schema.idField || 'id';

  // 1. Parse Input
  let rawRows: Record<string, any>[] = [];
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        rawRows = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e: any) {
        return {
          success: false,
          dryRun: isDryRun,
          entityType,
          summary: {
            totalRows: 0,
            validRows: 0,
            invalidRows: 0,
            createCount: 0,
            updateCount: 0,
            skipCount: 0,
            errorCount: 1,
            duplicateCount: 0,
          },
          rows: [],
          errors: [`JSON parsing failed: ${e.message}`],
        };
      }
    } else {
      rawRows = parseCSV(trimmed);
    }
  } else {
    rawRows = Array.isArray(input) ? input : [input];
  }

  if (rawRows.length === 0) {
    return {
      success: true,
      dryRun: isDryRun,
      entityType,
      summary: {
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        createCount: 0,
        updateCount: 0,
        skipCount: 0,
        errorCount: 0,
        duplicateCount: 0,
      },
      rows: [],
      errors: [],
    };
  }

  // Check cancellation before processing
  if (options.signal?.aborted) {
    return {
      success: false,
      cancelled: true,
      cancellationReason: 'Import was cancelled before processing started',
      cancelledAt: new Date().toISOString(),
      dryRun: isDryRun,
      entityType,
      summary: {
        totalRows: rawRows.length,
        validRows: 0,
        invalidRows: 0,
        createCount: 0,
        updateCount: 0,
        skipCount: 0,
        errorCount: 0,
        duplicateCount: 0,
      },
      rows: [],
      errors: ['Import cancelled before processing'],
      rollbackGuidance: {
        snapshotId: `snap_${Date.now()}`,
        timestamp: new Date().toISOString(),
        rollbackSupported: true,
        totalAffectedRecords: 0,
        affectedExternalIds: [],
        remediationSteps: ['Import was cancelled prior to validation or persistent storage.'],
        compensationSteps: [],
      },
      appliedRecords: [],
    };
  }

  // 2. Validate and Plan Actions
  const existingStore = importStore.getStore(entityType);
  const seenBatchIds = new Set<string>();
  const validationResults: RowValidationResult[] = [];
  let createCount = 0;
  let updateCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  let duplicateCount = 0;
  const pipelineErrors: string[] = [];

  const compensationSteps: RollbackCompensationStep[] = [];
  const affectedExternalIds: string[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    if (options.signal?.aborted) {
      return {
        success: false,
        cancelled: true,
        cancellationReason: `Import was cancelled during row validation (row ${i + 1} of ${rawRows.length})`,
        cancelledAt: new Date().toISOString(),
        dryRun: isDryRun,
        entityType,
        summary: {
          totalRows: rawRows.length,
          validRows: validationResults.filter((r) => r.valid).length,
          invalidRows: validationResults.filter((r) => !r.valid).length,
          createCount,
          updateCount,
          skipCount,
          errorCount,
          duplicateCount,
        },
        rows: validationResults,
        errors: ['Import cancelled during validation'],
        rollbackGuidance: {
          snapshotId: `snap_${Date.now()}`,
          timestamp: new Date().toISOString(),
          rollbackSupported: true,
          totalAffectedRecords: 0,
          affectedExternalIds: [],
          remediationSteps: ['Import cancelled during validation; no records were written.'],
          compensationSteps: [],
        },
        appliedRecords: [],
      };
    }

    const rowNumber = i + 1;
    const row = rawRows[i];
    const externalId = row[idKey] !== undefined && row[idKey] !== null ? String(row[idKey]) : undefined;

    if (options.onProgress) {
      options.onProgress({
        processed: i,
        total: rawRows.length,
        current_item: externalId || `row-${rowNumber}`,
        errors: errorCount,
      });
    }

    // Validate Schema
    const val = validateRow(row, schema, rowNumber);

    // Check Batch Duplicates
    if (externalId) {
      if (seenBatchIds.has(externalId)) {
        duplicateCount++;
        val.valid = false;
        val.errors.push({
          field: idKey,
          message: `Duplicate external ID '${externalId}' found in import batch`,
          value: externalId,
        });
      } else {
        seenBatchIds.add(externalId);
      }
    }

    if (!val.valid) {
      errorCount++;
      validationResults.push({
        rowNumber,
        externalId,
        action: 'error',
        valid: false,
        errors: val.errors,
        data: row,
      });

      if (stopOnError) {
        pipelineErrors.push(`Import halted on row ${rowNumber} due to validation errors`);
        break;
      }
      continue;
    }

    // Determine Action (create vs update vs skip)
    let action: 'create' | 'update' | 'skip' = 'create';
    let beforeData: Record<string, any> | undefined = undefined;

    if (externalId && existingStore.has(externalId)) {
      beforeData = existingStore.get(externalId);
      if (idempotent && !allowUpdate) {
        action = 'skip';
        skipCount++;
      } else if (allowUpdate) {
        action = 'update';
        updateCount++;
      } else {
        action = 'skip';
        skipCount++;
      }
    } else {
      action = 'create';
      createCount++;
    }

    validationResults.push({
      rowNumber,
      externalId,
      action,
      valid: true,
      errors: [],
      data: row,
      diff: beforeData ? { before: beforeData, after: row } : undefined,
    });
  }

  const validRows = validationResults.filter((r) => r.valid).length;
  const invalidRows = validationResults.filter((r) => !r.valid).length;
  const isOverallSuccess = invalidRows === 0 && pipelineErrors.length === 0;

  // 3. Rollback Guidance Generation
  const snapshotId = `snap_${Date.now()}`;
  let stepIndex = 1;

  for (const rowRes of validationResults) {
    if (!rowRes.valid || rowRes.action === 'skip' || !rowRes.externalId) continue;
    affectedExternalIds.push(rowRes.externalId);

    if (rowRes.action === 'create') {
      compensationSteps.push({
        step: stepIndex++,
        action: 'delete',
        targetId: rowRes.externalId,
        description: `Delete created record '${rowRes.externalId}'`,
      });
    } else if (rowRes.action === 'update' && rowRes.diff?.before) {
      compensationSteps.push({
        step: stepIndex++,
        action: 'restore',
        targetId: rowRes.externalId,
        description: `Restore original state for record '${rowRes.externalId}'`,
        payload: rowRes.diff.before,
      });
    }
  }

  const rollbackGuidance: RollbackGuidance = {
    snapshotId,
    timestamp: new Date().toISOString(),
    rollbackSupported: true,
    totalAffectedRecords: affectedExternalIds.length,
    affectedExternalIds,
    remediationSteps: [
      '1. Review invalid row error logs and fix missing or malformed fields.',
      '2. If external IDs were duplicated in the batch, assign unique identifiers or group them.',
      '3. In case of partial failure during live import, execute the compensation steps or restore the snapshot.',
      '4. Re-run import with dryRun: true to verify 100% validity before applying changes.',
    ],
    compensationSteps,
    sqlRecoveryScript: affectedExternalIds.length
      ? `-- Trellis Rollback Script for Snapshot ${snapshotId}\n` +
        compensationSteps
          .map((s) => (s.action === 'delete' ? `DELETE FROM ${entityType} WHERE id = '${s.targetId}';` : `-- Restore payload for ${s.targetId}`))
          .join('\n')
      : undefined,
  };

  // 4. Apply Persistent Writes (ONLY IF dryRun === false)
  const appliedRecords: Record<string, any>[] = [];
  if (!isDryRun && isOverallSuccess) {
    const preWriteSnapshotId = importStore.createSnapshot(entityType);

    for (let i = 0; i < validationResults.length; i++) {
      const res = validationResults[i];

      if (options.onProgress) {
        options.onProgress({
          processed: i,
          total: validationResults.length,
          current_item: `write-${res.externalId || i + 1}`,
          errors: 0,
        });
      }

      if (options.signal?.aborted) {
        // CANCELLATION DETECTED DURING WRITES!
        // Execute automatic safe rollback to pre-write snapshot
        importStore.restoreSnapshot(preWriteSnapshotId);

        return {
          success: false,
          cancelled: true,
          cancellationReason: `Import was cancelled mid-write (row ${i + 1} of ${validationResults.length}); state safely rolled back to pre-import snapshot`,
          cancelledAt: new Date().toISOString(),
          dryRun: false,
          entityType,
          summary: {
            totalRows: rawRows.length,
            validRows,
            invalidRows,
            createCount,
            updateCount,
            skipCount,
            errorCount,
            duplicateCount,
          },
          rows: validationResults,
          errors: ['Import was cancelled during write execution. Automatic rollback restored previous state.'],
          rollbackGuidance: {
            ...rollbackGuidance,
            snapshotId: preWriteSnapshotId,
            remediationSteps: [
              'Import was cancelled during persistent write execution.',
              'All partially written records were automatically rolled back to snapshot.',
              'Database state remains consistent and uncorrupted.',
              'Import can be safely retried idempotently when ready.',
            ],
          },
          appliedRecords: [],
        };
      }

      if (!res.valid || res.action === 'skip') continue;
      const recId = res.externalId || `gen_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const savedData = { ...res.data, [idKey]: recId };
      existingStore.set(recId, savedData);
      appliedRecords.push(savedData);
    }
  }

  return {
    success: isOverallSuccess,
    dryRun: isDryRun,
    entityType,
    summary: {
      totalRows: rawRows.length,
      validRows,
      invalidRows,
      createCount,
      updateCount,
      skipCount,
      errorCount,
      duplicateCount,
    },
    rows: validationResults,
    errors: pipelineErrors,
    rollbackGuidance,
    appliedRecords: isDryRun ? undefined : appliedRecords,
  };
}
