/** @jest-environment node */
import { NextRequest } from 'next/server';
import { runImportPipeline, importStore } from '@/lib/import/pipeline';
import { runImportPipelineWithProgress } from '@/lib/import/stream';
import { streamingExport, type ExportRequest, type RecordFetcher, type StreamWriter } from '@/lib/export/streaming-export';
import { operationRegistry } from '@/lib/cancellation';
import { POST as cancelOperationRoute } from '@/app/api/operations/cancel/route';
import { GET as getOperationRoute } from '@/app/api/operations/route';
import { POST as importRoute } from '@/app/api/import/route';
import { POST as exportRoute } from '@/app/api/export/route';
import { issueActorToken } from '@/lib/auth';

const TEST_SECRET = 'test-only-secret-that-is-at-least-32-characters';
const WALLET_OWNER = 'G'.repeat(56);
const WALLET_OTHER = 'A'.repeat(56);

describe('Safe Cancellation for Long-Running Imports and Exports (Issue #325)', () => {
  const previousSecret = process.env.PERMISSION_TOKEN_SECRET;

  beforeAll(() => {
    process.env.PERMISSION_TOKEN_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.PERMISSION_TOKEN_SECRET;
    } else {
      process.env.PERMISSION_TOKEN_SECRET = previousSecret;
    }
  });

  beforeEach(() => {
    importStore.clear('agents');
    importStore.clear('general');
    operationRegistry.clear();
  });

  // ==========================================================================
  // 1. Normal Paths
  // ==========================================================================
  describe('Normal Execution Paths', () => {
    it('executes import pipeline to normal completion with live writes', () => {
      const records = [
        { id: 'ag-1', name: 'Alpha Agent', description: 'Description Alpha' },
        { id: 'ag-2', name: 'Beta Agent', description: 'Description Beta' },
      ];

      const result = runImportPipeline(records, { entityType: 'agents', dryRun: false });

      expect(result.success).toBe(true);
      expect(result.cancelled).toBeFalsy();
      expect(result.summary.createCount).toBe(2);
      expect(importStore.getAll('agents').length).toBe(2);
    });

    it('streams export records in batches with full completion', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (c) => { chunks.push(c); };

      const fetcher: RecordFetcher = async (offset, limit) => {
        if (offset >= 6) return [];
        return Array.from({ length: Math.min(limit, 6 - offset) }, (_, i) => ({
          data: { id: `sim-${offset + i}` },
          fieldPermissions: new Map(),
        }));
      };

      const request: ExportRequest = {
        wallet: WALLET_OWNER,
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'admin-1',
      };

      const metadata = await streamingExport(
        request,
        fetcher,
        writer,
        new AbortController().signal,
        { batchSize: 2 },
      );

      expect(metadata.cancelled).toBe(false);
      expect(metadata.recordCount).toBe(6);
      expect(metadata.error).toBeUndefined();
      const output = chunks.join('');
      expect(output.startsWith('[\n')).toBe(true);
      expect(output.endsWith('\n]')).toBe(true);
    });

    it('manages operation registry normal lifecycle (register -> complete)', () => {
      const { id, signal, record } = operationRegistry.register({
        type: 'import',
        ownerWallet: WALLET_OWNER,
      });

      expect(record.status).toBe('running');
      expect(signal.aborted).toBe(false);

      const completed = operationRegistry.complete(id, { total: 100 });
      expect(completed).toBe(true);

      const op = operationRegistry.get(id);
      expect(op.ok).toBe(true);
      if (op.ok) {
        expect(op.operation.status).toBe('completed');
        expect(op.operation.metadata?.total).toBe(100);
      }
    });
  });

  // ==========================================================================
  // 2. Failure Paths
  // ==========================================================================
  describe('Failure Paths', () => {
    it('handles import validation failures with rollback compensation guidance', () => {
      const records = [
        { id: 'ag-1', name: '', description: 'Invalid empty name' },
        { id: 'ag-1', name: 'Duplicate ID', description: 'Duplicate batch key' },
      ];

      const result = runImportPipeline(records, { entityType: 'agents', dryRun: false });

      expect(result.success).toBe(false);
      expect(result.cancelled).toBeFalsy();
      expect(result.summary.errorCount).toBeGreaterThan(0);
      expect(result.rollbackGuidance).toBeDefined();
      expect(importStore.getAll('agents').length).toBe(0);
    });

    it('handles export fetcher errors when max retries are exhausted without falsely marking cancelled', async () => {
      const chunks: string[] = [];
      const writer: StreamWriter = async (c) => { chunks.push(c); };

      const fetcher: RecordFetcher = async () => {
        throw new Error('Database connection failed');
      };

      const request: ExportRequest = {
        wallet: WALLET_OWNER,
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'admin-1',
      };

      const metadata = await streamingExport(
        request,
        fetcher,
        writer,
        new AbortController().signal,
        { maxRetries: 1, retryDelayMs: 5 },
      );

      expect(metadata.cancelled).toBe(false);
      expect(metadata.error).toContain('Database connection failed');
    });
  });

  // ==========================================================================
  // 3. Safe Cancellation & Automatic Snapshot Rollback for Imports
  // ==========================================================================
  describe('Safe Cancellation & Rollback for Imports', () => {
    it('handles early cancellation before import execution starts', () => {
      const controller = new AbortController();
      controller.abort('User cancelled before start');

      const records = [{ id: 'ag-1', name: 'Agent 1', description: 'Desc 1' }];

      const result = runImportPipeline(records, {
        entityType: 'agents',
        dryRun: false,
        signal: controller.signal,
      });

      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.cancellationReason).toContain('cancelled before processing');
      expect(result.appliedRecords).toEqual([]);
      expect(importStore.getAll('agents').length).toBe(0);
    });

    it('safely rolls back partial live writes to pre-import snapshot when cancelled mid-execution', () => {
      // 1. Establish baseline store state
      importStore.set('agents', 'pre-existing-1', {
        id: 'pre-existing-1',
        name: 'Pre-existing Agent',
        description: 'Should remain untouched after rollback',
      });
      expect(importStore.getAll('agents').length).toBe(1);

      // 2. Prepare import payload with multiple records
      const records = [
        { id: 'new-1', name: 'New Agent 1', description: 'Valid desc 1' },
        { id: 'new-2', name: 'New Agent 2', description: 'Valid desc 2' },
        { id: 'new-3', name: 'New Agent 3', description: 'Valid desc 3' },
      ];

      const controller = new AbortController();

      // Hook into progress during write execution
      let writeCalls = 0;
      const onProgress = (p: any) => {
        if (p.current_item?.startsWith('write-')) {
          writeCalls++;
          if (writeCalls === 2) {
            controller.abort('Abort signal triggered during write phase');
          }
        }
      };

      const result = runImportPipeline(records, {
        entityType: 'agents',
        dryRun: false,
        signal: controller.signal,
        onProgress,
      });


      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.cancellationReason).toContain('cancelled');
      expect(result.errors.some((e) => e.includes('Automatic rollback'))).toBe(true);

      // CRITICAL VERIFICATION:
      // The store must ONLY have the pre-existing record; partial writes must be 100% rolled back!
      const currentStoreRecords = importStore.getAll('agents');
      expect(currentStoreRecords.length).toBe(1);
      expect(currentStoreRecords[0].id).toBe('pre-existing-1');
      expect(importStore.getExisting('agents', 'new-1')).toBeUndefined();
      expect(importStore.getExisting('agents', 'new-2')).toBeUndefined();
    });

    it('supports idempotent retry following a cancelled import', () => {
      const records = [
        { id: 'retry-1', name: 'Retry Agent 1', description: 'Description 1' },
        { id: 'retry-2', name: 'Retry Agent 2', description: 'Description 2' },
      ];

      // Step 1: Initial run is cancelled
      const abortController = new AbortController();
      abortController.abort();
      const cancelledResult = runImportPipeline(records, {
        entityType: 'agents',
        dryRun: false,
        signal: abortController.signal,
      });
      expect(cancelledResult.cancelled).toBe(true);
      expect(importStore.getAll('agents').length).toBe(0);

      // Step 2: Retry cleanly with normal signal
      const retryResult = runImportPipeline(records, {
        entityType: 'agents',
        dryRun: false,
        idempotent: true,
      });

      expect(retryResult.success).toBe(true);
      expect(retryResult.summary.createCount).toBe(2);
      expect(importStore.getAll('agents').length).toBe(2);
      expect(importStore.getExisting('agents', 'retry-1')?.name).toBe('Retry Agent 1');
    });

    it('handles cancellation in runImportPipelineWithProgress stream helper', async () => {
      const controller = new AbortController();
      controller.abort();

      const progressUpdates: any[] = [];
      const result = await runImportPipelineWithProgress(
        [{ id: 'ag-stream-1', name: 'Stream Agent', description: 'Desc' }],
        { entityType: 'agents', dryRun: false },
        (p) => progressUpdates.push(p),
        controller.signal,
      );

      expect(result.cancelled).toBe(true);
      expect(importStore.getAll('agents').length).toBe(0);
    });
  });

  // ==========================================================================
  // 4. Safe Cancellation & Retry for Exports
  // ==========================================================================
  describe('Safe Cancellation & Retry for Exports', () => {
    it('aborts export batch fetching cleanly when signal is triggered', async () => {
      const controller = new AbortController();
      const chunks: string[] = [];
      const writer: StreamWriter = async (c) => { chunks.push(c); };
      let fetchCalls = 0;

      const fetcher: RecordFetcher = async (offset, limit, signal) => {
        fetchCalls++;
        if (fetchCalls === 2) {
          controller.abort('Client cancelled export on batch 2');
        }
        if (signal.aborted) return [];
        return Array.from({ length: limit }, (_, i) => ({
          data: { id: `sim-${offset + i}` },
          fieldPermissions: new Map(),
        }));
      };

      const request: ExportRequest = {
        wallet: WALLET_OWNER,
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'admin-1',
      };

      const metadata = await streamingExport(
        request,
        fetcher,
        writer,
        controller.signal,
        { batchSize: 2 },
      );

      expect(metadata.cancelled).toBe(true);
      expect(metadata.cancellationReason).toBeDefined();
      expect(metadata.error).toBeUndefined();
      expect(fetchCalls).toBeLessThanOrEqual(2);
    });

    it('terminates retry backoff immediately when cancelled during delay', async () => {
      const controller = new AbortController();
      const chunks: string[] = [];
      const writer: StreamWriter = async (c) => { chunks.push(c); };

      let attempts = 0;
      const fetcher: RecordFetcher = async () => {
        attempts++;
        if (attempts === 1) {
          // Trigger abort shortly during the retry backoff delay
          setTimeout(() => {
            controller.abort('Abort during retry backoff');
          }, 10);
          throw new Error('Transient error to induce backoff');
        }
        return [];
      };

      const request: ExportRequest = {
        wallet: WALLET_OWNER,
        type: 'simulations',
        format: 'json',
        role: 'admin',
        actorId: 'admin-1',
      };

      const startTime = Date.now();
      const metadata = await streamingExport(
        request,
        fetcher,
        writer,
        controller.signal,
        { maxRetries: 3, retryDelayMs: 2000 }, // 2s delay, but should abort in ~10ms
      );
      const elapsed = Date.now() - startTime;

      expect(metadata.cancelled).toBe(true);
      expect(metadata.error).toBeUndefined();
      expect(elapsed).toBeLessThan(1000); // Proves delay was cancelled immediately!
    });
  });

  // ==========================================================================
  // 5. Authorization Path for Operations & Cancellation
  // ==========================================================================
  describe('Authorization Path for Cancellation & Operations', () => {
    async function issueAuthHeader(role: 'admin' | 'maintainer' | 'contributor' | 'viewer' | 'guest', id: string) {
      const token = await issueActorToken({ id, role });
      return `Bearer ${token}`;
    }

    it('rejects unauthenticated requests to POST /api/operations/cancel with 401', async () => {
      const req = new NextRequest('https://example.test/api/operations/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'op_nonexistent' }),
      });

      const res = await cancelOperationRoute(req);
      expect(res.status).toBe(401);
    });

    it('rejects cancellation attempts from viewer role with 403 Forbidden', async () => {
      const { id } = operationRegistry.register({
        type: 'import',
        ownerWallet: WALLET_OWNER,
      });

      const authHeader = await issueAuthHeader('viewer', WALLET_OWNER);
      const req = new NextRequest('https://example.test/api/operations/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: authHeader,
        },
        body: JSON.stringify({ operationId: id, reason: 'Viewer trying to cancel' }),
      });

      const res = await cancelOperationRoute(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain("Role 'viewer' cannot cancel operations");
    });

    it('rejects contributor trying to cancel an operation owned by a different wallet with 403', async () => {
      const { id } = operationRegistry.register({
        type: 'export',
        ownerWallet: WALLET_OWNER, // Owned by WALLET_OWNER
      });

      const authHeader = await issueAuthHeader('contributor', WALLET_OTHER); // Requester is WALLET_OTHER
      const req = new NextRequest('https://example.test/api/operations/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: authHeader,
        },
        body: JSON.stringify({ operationId: id }),
      });

      const res = await cancelOperationRoute(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('operations owned by other wallets');
    });

    it('allows contributor to cancel their OWN operation', async () => {
      const { id, signal } = operationRegistry.register({
        type: 'export',
        ownerWallet: WALLET_OWNER,
      });

      const authHeader = await issueAuthHeader('contributor', WALLET_OWNER);
      const req = new NextRequest('https://example.test/api/operations/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: authHeader,
        },
        body: JSON.stringify({ operationId: id, reason: 'Owner cancelled export' }),
      });

      const res = await cancelOperationRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.operation.status).toBe('cancelled');
      expect(signal.aborted).toBe(true);
    });

    it('allows admin to cancel ANY operation across the platform', async () => {
      const { id, signal } = operationRegistry.register({
        type: 'import',
        ownerWallet: WALLET_OWNER,
      });

      const authHeader = await issueAuthHeader('admin', 'admin-actor-id');
      const req = new NextRequest('https://example.test/api/operations/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: authHeader,
        },
        body: JSON.stringify({ operationId: id, reason: 'Admin emergency cancel' }),
      });

      const res = await cancelOperationRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.operation.status).toBe('cancelled');
      expect(signal.aborted).toBe(true);
    });

    it('returns 409 Conflict when attempting to cancel an already completed operation', async () => {
      const { id } = operationRegistry.register({
        type: 'import',
        ownerWallet: WALLET_OWNER,
      });
      operationRegistry.complete(id);

      const authHeader = await issueAuthHeader('admin', 'admin-actor-id');
      const req = new NextRequest('https://example.test/api/operations/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: authHeader,
        },
        body: JSON.stringify({ operationId: id }),
      });

      const res = await cancelOperationRoute(req);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain('already in');
    });

    it('returns 404 when attempting to cancel a non-existent operation', async () => {
      const authHeader = await issueAuthHeader('admin', 'admin-actor-id');
      const req = new NextRequest('https://example.test/api/operations/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: authHeader,
        },
        body: JSON.stringify({ operationId: 'op_nonexistent_12345' }),
      });

      const res = await cancelOperationRoute(req);
      expect(res.status).toBe(404);
    });

    it('enforces inspection authorization on GET /api/operations', async () => {
      const { id } = operationRegistry.register({
        type: 'export',
        ownerWallet: WALLET_OWNER,
      });

      // 1. Other wallet receives 403
      const otherAuth = await issueAuthHeader('contributor', WALLET_OTHER);
      const reqOther = new NextRequest(`https://example.test/api/operations?id=${id}`, {
        headers: { authorization: otherAuth },
      });
      const resOther = await getOperationRoute(reqOther);
      expect(resOther.status).toBe(403);

      // 2. Owner receives 200
      const ownerAuth = await issueAuthHeader('contributor', WALLET_OWNER);
      const reqOwner = new NextRequest(`https://example.test/api/operations?id=${id}`, {
        headers: { authorization: ownerAuth },
      });
      const resOwner = await getOperationRoute(reqOwner);
      expect(resOwner.status).toBe(200);
      const jsonOwner = await resOwner.json();
      expect(jsonOwner.operation.id).toBe(id);
    });

    it('enforces import_data authorization on POST /api/import when credentials are supplied', async () => {
      const payload = [{ id: 'ag-auth-1', name: 'Agent', description: 'Valid Description' }];
      const csrfToken = 'a'.repeat(32);

      // Viewer lacks import_data permission -> 403
      const viewerAuth = await issueAuthHeader('viewer', WALLET_OWNER);
      const reqViewer = new NextRequest('https://example.test/api/import?entityType=agents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: viewerAuth,
          'x-csrf-token': csrfToken,
          cookie: `csrf-token=${csrfToken}`,
        },
        body: JSON.stringify({ data: payload }),
      });
      const resViewer = await importRoute(reqViewer);
      expect(resViewer.status).toBe(403);

      // Admin has import_data permission -> 200
      const adminAuth = await issueAuthHeader('admin', WALLET_OWNER);
      const reqAdmin = new NextRequest('https://example.test/api/import?entityType=agents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: adminAuth,
          'x-csrf-token': csrfToken,
          cookie: `csrf-token=${csrfToken}`,
        },
        body: JSON.stringify({ data: payload }),
      });
      const resAdmin = await importRoute(reqAdmin);
      expect(resAdmin.status).toBe(200);
      expect(resAdmin.headers.get('x-operation-id')).toBeDefined();
    });
  });
});

