import { Role } from '@/lib/permissions';

export type OperationType = 'import' | 'export';
export type OperationStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface OperationActor {
  id: string;
  role: Role;
}

export interface OperationRecord {
  id: string;
  type: OperationType;
  ownerWallet: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  cancelledBy?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterOperationParams {
  id?: string;
  type: OperationType;
  ownerWallet: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CancellationResult {
  ok: boolean;
  status: 200 | 401 | 403 | 404 | 409;
  operation?: OperationRecord;
  error?: string;
}

interface ActiveOperationEntry {
  record: OperationRecord;
  controller: AbortController;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Centralized, thread-safe (in-memory) registry for long-running imports and exports.
 * Provides safe cancellation, status queries, TTL cleanup, and role-based authorization.
 */
export class OperationCancellationRegistry {
  private operations = new Map<string, ActiveOperationEntry>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs = 15 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Register a new long-running operation.
   */
  register(params: RegisterOperationParams): {
    id: string;
    signal: AbortSignal;
    controller: AbortController;
    record: OperationRecord;
  } {
    const id = params.id || `op_${params.type}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const controller = new AbortController();
    const now = new Date().toISOString();

    const record: OperationRecord = {
      id,
      type: params.type,
      ownerWallet: params.ownerWallet,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      metadata: params.metadata || {},
    };

    // If an external signal (e.g. client disconnect) aborts, propagate to controller
    if (params.signal) {
      if (params.signal.aborted) {
        controller.abort(params.signal.reason);
        record.status = 'cancelled';
        record.cancelledAt = new Date().toISOString();
        record.cancellationReason = 'Client disconnected prior to registration';
      } else {
        params.signal.addEventListener(
          'abort',
          () => {
            if (record.status === 'running') {
              controller.abort('Client disconnected');
              record.status = 'cancelled';
              record.cancelledAt = new Date().toISOString();
              record.cancellationReason = 'Client connection aborted';
              record.updatedAt = new Date().toISOString();
            }
          },
          { once: true },
        );
      }
    }

    const entry: ActiveOperationEntry = {
      record,
      controller,
    };

    this.operations.set(id, entry);

    return {
      id,
      signal: controller.signal,
      controller,
      record,
    };
  }

  /**
   * Complete an operation successfully.
   */
  complete(id: string, metadataUpdates?: Record<string, unknown>): boolean {
    const entry = this.operations.get(id);
    if (!entry) return false;

    const now = new Date().toISOString();
    entry.record.status = 'completed';
    entry.record.completedAt = now;
    entry.record.updatedAt = now;
    if (metadataUpdates) {
      entry.record.metadata = { ...entry.record.metadata, ...metadataUpdates };
    }

    this.scheduleCleanup(id);
    return true;
  }

  /**
   * Fail an operation with an error.
   */
  fail(id: string, error: string): boolean {
    const entry = this.operations.get(id);
    if (!entry) return false;

    const now = new Date().toISOString();
    entry.record.status = 'failed';
    entry.record.error = error;
    entry.record.updatedAt = now;

    this.scheduleCleanup(id);
    return true;
  }

  /**
   * Safely cancel an operation with role-based authorization checks.
   */
  cancel(id: string, actor: OperationActor, reason?: string): CancellationResult {
    const entry = this.operations.get(id);
    if (!entry) {
      return {
        ok: false,
        status: 404,
        error: `Operation '${id}' not found`,
      };
    }

    const { record, controller } = entry;

    // Check authorization:
    // Admin and maintainer can cancel any operation.
    // Contributor can ONLY cancel their own operation.
    // Viewer and guest cannot cancel operations.
    if (actor.role === 'admin' || actor.role === 'maintainer') {
      // Allowed
    } else if (actor.role === 'contributor') {
      if (record.ownerWallet !== actor.id) {
        return {
          ok: false,
          status: 403,
          error: 'Forbidden: You do not have permission to cancel operations owned by other wallets',
        };
      }
    } else {
      return {
        ok: false,
        status: 403,
        error: `Forbidden: Role '${actor.role}' cannot cancel operations`,
      };
    }

    // Terminal state check
    if (record.status !== 'running') {
      return {
        ok: false,
        status: 409,
        error: `Cannot cancel operation '${id}': already in '${record.status}' state`,
      };
    }

    const now = new Date().toISOString();
    const finalReason = reason || 'Cancelled by user request';

    controller.abort(finalReason);
    record.status = 'cancelled';
    record.cancelledAt = now;
    record.cancellationReason = finalReason;
    record.cancelledBy = actor.id;
    record.updatedAt = now;

    this.scheduleCleanup(id);

    return {
      ok: true,
      status: 200,
      operation: { ...record },
    };
  }

  /**
   * Get an operation's record, with optional authorization verification.
   */
  get(
    id: string,
    actor?: OperationActor,
  ): { ok: true; operation: OperationRecord } | { ok: false; status: 403 | 404; error: string } {
    const entry = this.operations.get(id);
    if (!entry) {
      return { ok: false, status: 404, error: `Operation '${id}' not found` };
    }

    if (actor) {
      const isOwner = entry.record.ownerWallet === actor.id;
      const isPrivileged = actor.role === 'admin' || actor.role === 'maintainer';
      if (!isOwner && !isPrivileged) {
        return {
          ok: false,
          status: 403,
          error: 'Forbidden: You do not have permission to inspect this operation',
        };
      }
    }

    return { ok: true, operation: { ...entry.record } };
  }

  /**
   * List all operations belonging to a given wallet.
   */
  listByOwner(ownerWallet: string): OperationRecord[] {
    const list: OperationRecord[] = [];
    for (const entry of this.operations.values()) {
      if (entry.record.ownerWallet === ownerWallet) {
        list.push({ ...entry.record });
      }
    }
    return list;
  }

  /**
   * Clear all operations (used in unit test setup/teardown).
   */
  clear(): void {
    for (const entry of this.operations.values()) {
      if (entry.cleanupTimer) {
        clearTimeout(entry.cleanupTimer);
      }
    }
    this.operations.clear();
  }

  private scheduleCleanup(id: string): void {
    const entry = this.operations.get(id);
    if (!entry) return;

    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
    }

    entry.cleanupTimer = setTimeout(() => {
      this.operations.delete(id);
    }, this.defaultTtlMs);
    entry.cleanupTimer?.unref?.();
  }
}

export const operationRegistry = new OperationCancellationRegistry();
