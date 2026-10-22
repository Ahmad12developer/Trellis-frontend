import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/auth';
import { buildPermissionDiff, ROLES, SCOPES } from '@/lib/permissions';

const PermissionDiffRequestSchema = z.object({
  fromRole: z.enum(ROLES),
  toRole: z.enum(ROLES),
  scope: z.enum(SCOPES).default('project'),
}).strict();

/** Read-only permission preview used before an operator changes a role. */
export async function POST(request: NextRequest) {
  const auth = await requirePermission(request, {
    action: 'view_permissions',
    resourceScope: 'project',
  });
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = PermissionDiffRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed.', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const changes = buildPermissionDiff(
    parsed.data.fromRole,
    parsed.data.toRole,
    parsed.data.scope,
  );
  return NextResponse.json({
    fromRole: parsed.data.fromRole,
    toRole: parsed.data.toRole,
    scope: parsed.data.scope,
    summary: {
      granted: changes.filter(({ change }) => change === 'granted').length,
      revoked: changes.filter(({ change }) => change === 'revoked').length,
      modified: changes.filter(({ change }) => change === 'modified').length,
    },
    changes,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
