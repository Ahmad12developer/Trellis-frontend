import { NextRequest, NextResponse } from 'next/server';
import { runImportPipeline } from '@/lib/import/pipeline';
import { ImportOptions } from '@/lib/import/types';
import { runImportPipelineWithProgress } from '@/lib/import/stream';
import { checkRateLimit, createRateLimitResponse } from '@/lib/security/rate-limit';
import { csrfMiddleware } from '@/lib/security/csrf';
import { requirePermission } from '@/lib/auth/guard';
import { operationRegistry } from '@/lib/cancellation';

const IMPORT_RATE_LIMIT = { maxRequests: 10, windowMs: 15 * 60 * 1000, scope: 'import' };

/**
 * POST /api/import
 * Execute bulk import pipeline with validation, idempotency, duplicate detection, rollback guidance, and safe cancellation.
 */
export async function POST(request: NextRequest) {
  const csrfError = csrfMiddleware(request);
  if (csrfError) return csrfError;

  const rl = checkRateLimit(request, IMPORT_RATE_LIMIT);
  if (rl.blocked) {
    return createRateLimitResponse(rl, 'Import rate limit exceeded. Please try again later.');
  }

  // Authorization check when caller provides credentials
  let ownerWallet = request.headers.get('x-wallet-address') || 'system';
  if (request.headers.get('authorization')) {
    const authResult = await requirePermission(request, {
      action: 'import_data',
      resourceScope: 'project',
    });
    if (!authResult.ok) {
      return authResult.response;
    }
    ownerWallet = authResult.actor.id;
  }

  try {
    const contentType = request.headers.get('content-type') || '';
    const { searchParams } = new URL(request.url);
    const dryRunParam = searchParams.get('dryRun');

    let bodyData: any;
    let options: ImportOptions = {
      dryRun: dryRunParam !== null ? dryRunParam === 'true' : false,
      entityType: (searchParams.get('entityType') as any) || 'general',
      idempotent: searchParams.get('idempotent') !== 'false',
      allowUpdate: searchParams.get('allowUpdate') !== 'false',
    };

    if (contentType.includes('application/json')) {
      const json = await request.json();
      if (json.data) {
        bodyData = json.data;
        options = { ...options, ...json.options };
      } else {
        bodyData = json;
      }
    } else if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      bodyData = await request.text();
    } else {
      const text = await request.text();
      try {
        bodyData = JSON.parse(text);
      } catch {
        bodyData = text;
      }
    }

    const requestedOpId = searchParams.get('operationId') || request.headers.get('x-operation-id') || undefined;
    const op = operationRegistry.register({
      id: requestedOpId,
      type: 'import',
      ownerWallet,
      metadata: { entityType: options.entityType, dryRun: options.dryRun },
      signal: request.signal,
    });
    options.signal = op.signal;

    const wantsStream = request.headers.get('accept')?.includes('text/event-stream') || searchParams.get('stream') === 'true';
    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          send('start', { total: typeof bodyData === 'string' ? Math.max(0, bodyData.trim().split(/\r?\n/).length - 1) : bodyData.length });
          try {
            const result = await runImportPipelineWithProgress(bodyData, options, (progress) => send('progress', progress), op.signal);
            if (result.cancelled) {
              send('cancelled', result);
            } else if (!result.success) {
              operationRegistry.fail(op.id, result.errors.join('; '));
              send('complete', result);
            } else {
              operationRegistry.complete(op.id, { summary: result.summary });
              send('complete', result);
            }
          } catch (error) {
            operationRegistry.fail(op.id, error instanceof Error ? error.message : 'Import failed');
            send('error', { message: error instanceof Error ? error.message : 'Import failed' });
          } finally { controller.close(); }
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'x-operation-id': op.id,
        },
      });
    }

    const result = runImportPipeline(bodyData, options);
    if (result.cancelled) {
      // Cancelled cleanly
    } else if (result.success) {
      operationRegistry.complete(op.id, { summary: result.summary });
    } else {
      operationRegistry.fail(op.id, result.errors.join('; '));
    }

    const statusCode = result.cancelled ? 200 : result.success ? 200 : 422;

    return NextResponse.json(result, {
      status: statusCode,
      headers: {
        'x-operation-id': op.id,
      },
    });

  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err.message || 'Internal import processing error',
      },
      { status: 500 }
    );
  }
}
