import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireActor } from '@/lib/auth/guard';
import { operationRegistry } from '@/lib/cancellation';

const CancelOperationSchema = z.object({
  operationId: z.string().min(1, 'operationId is required'),
  reason: z.string().optional(),
});

/**
 * POST /api/operations/cancel
 * Safely cancel a long-running import or export operation.
 *
 * Authorization rules:
 * - Admin and maintainer can cancel any operation.
 * - Contributor can only cancel operations belonging to their own wallet.
 * - Viewer and guest roles cannot cancel operations.
 */
export async function POST(request: NextRequest) {
  // 1. Authenticate caller
  const authResult = await requireActor(request);
  if (!authResult.ok) {
    return authResult.response;
  }

  // 2. Parse request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = CancelOperationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { operationId, reason } = parsed.data;

  // 3. Delegate cancellation to registry with actor authorization
  const result = operationRegistry.cancel(
    operationId,
    { id: authResult.actor.id, role: authResult.actor.role },
    reason,
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    success: true,
    operation: result.operation,
  });
}
