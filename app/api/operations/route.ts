import { NextRequest, NextResponse } from 'next/server';
import { requireActor } from '@/lib/auth/guard';
import { operationRegistry } from '@/lib/cancellation';

/**
 * GET /api/operations?id=<operationId>
 * Query the status of an active or recent operation.
 *
 * Authorization:
 * - Admin and maintainer can inspect any operation.
 * - Resource owner can inspect their own operation.
 * - Other callers receive 403 Forbidden.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireActor(request);
  if (!authResult.ok) {
    return authResult.response;
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: "Query parameter 'id' is required" }, { status: 400 });
  }

  const result = operationRegistry.get(id, {
    id: authResult.actor.id,
    role: authResult.actor.role,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    success: true,
    operation: result.operation,
  });
}
