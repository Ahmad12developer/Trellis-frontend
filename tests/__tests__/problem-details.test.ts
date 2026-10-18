/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import {
  PROBLEM_CODES,
  PROBLEM_DEFINITIONS,
  PROBLEM_DOCS_BASE,
  PROBLEM_TAXONOMY_VERSION,
  createProblemDetails,
  createProblemResponse,
  fromLegacyError,
  getProblemDefinition,
  isProblemCode,
  parseProblemDetails,
  problemDocsUrl,
  problemUserMessage,
} from '@/lib/api-contracts/problem-details';
import { API_CONTRACTS } from '@/lib/api-contracts/schemas';
import { GET as getEarnings } from '@/app/api/affiliates/earnings/route';

const DOCS = readFileSync(join(process.cwd(), 'docs', 'problem-details.md'), 'utf-8');

describe('Problem Details Taxonomy — registry contract', () => {
  it('exposes a versioned taxonomy', () => {
    expect(PROBLEM_TAXONOMY_VERSION).toBe('1');
  });

  it('has unique, stable codes matching the definitions object', () => {
    expect(new Set(PROBLEM_CODES).size).toBe(PROBLEM_CODES.length);
    expect(PROBLEM_CODES.sort()).toEqual(Object.keys(PROBLEM_DEFINITIONS).sort());
  });

  it('gives every code a valid status and non-empty safe copy', () => {
    for (const code of PROBLEM_CODES) {
      const definition = getProblemDefinition(code);
      expect(definition.status).toBeGreaterThanOrEqual(400);
      expect(definition.status).toBeLessThan(600);
      expect(definition.title.trim().length).toBeGreaterThan(0);
      expect(definition.detail.trim().length).toBeGreaterThan(0);
      expect(definition.remediation.trim().length).toBeGreaterThan(0);
      expect(typeof definition.retryable).toBe('boolean');
      // Safe-user-message guard: the registry must never ship raw provider or
      // stack text. These markers would signal a leak.
      expect(definition.detail).not.toMatch(/Error:|at .*\(|stack|ECONN|undefined/);
    }
  });

  it('documents every code with a matching anchor', () => {
    for (const code of PROBLEM_CODES) {
      expect(DOCS).toContain(`\`${code}\``);
      const anchor = code.toLowerCase().replace(/_/g, '-');
      expect(problemDocsUrl(code)).toBe(`${PROBLEM_DOCS_BASE}#${anchor}`);
      expect(DOCS).toContain(`#${anchor}`);
    }
  });

  it('fails loudly on an unknown code', () => {
    expect(() => getProblemDefinition('NOT_A_REAL_CODE' as never)).toThrow(/Unknown problem code/);
    expect(isProblemCode('NOT_A_REAL_CODE')).toBe(false);
  });

  it('registers every error code declared by a public endpoint contract', () => {
    for (const contract of Object.values(API_CONTRACTS)) {
      for (const errorDef of Object.values(contract.errorResponses)) {
        expect(isProblemCode(errorDef.code)).toBe(true);
      }
    }
  });
});

describe('Problem Details Taxonomy — payload builders', () => {
  it('builds an RFC 9457 document with legacy aliases and extensions', () => {
    const problem = createProblemDetails('INVALID_WALLET_ADDRESS', {
      instance: '/api/affiliates/earnings',
      correlationId: 'corr-123',
    });

    expect(problem).toMatchObject({
      type: problemDocsUrl('INVALID_WALLET_ADDRESS'),
      title: 'Invalid wallet address',
      status: 400,
      code: 'INVALID_WALLET_ADDRESS',
      retryable: false,
      instance: '/api/affiliates/earnings',
      correlationId: 'corr-123',
    });
    expect(problem.detail).toBe(problem.error);
    expect(problem.docs).toBe(problem.type);
    expect(problem.remediation.length).toBeGreaterThan(0);
  });

  it('omits optional fields when not supplied', () => {
    const problem = createProblemDetails('INTERNAL_ERROR');
    expect(problem.instance).toBeUndefined();
    expect(problem.correlationId).toBeUndefined();
  });

  it('produces a problem+json response with status and correlation header', async () => {
    const response = createProblemResponse('RATE_LIMITED', { instance: '/api/affiliates' });

    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const correlationId = response.headers.get('x-correlation-id');
    expect(correlationId).toBeTruthy();

    const body = await response.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.correlationId).toBe(correlationId);
  });

  it('parses objects and JSON strings but rejects unrelated payloads', () => {
    const problem = createProblemDetails('NOT_FOUND');
    expect(parseProblemDetails(problem)).toEqual(problem);
    expect(parseProblemDetails(JSON.stringify(problem))).toEqual(problem);
    expect(parseProblemDetails('{not json')).toBeNull();
    expect(parseProblemDetails({ code: 'MADE_UP' })).toBeNull();
    expect(parseProblemDetails(null)).toBeNull();
  });
});

describe('Problem Details Taxonomy — legacy compatibility', () => {
  it('maps a known legacy code to its problem document', () => {
    const problem = fromLegacyError({ error: 'boom: raw provider text', code: 'VALIDATION_FAILED' });
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.status).toBe(422);
    // The legacy prose must never be echoed back.
    expect(problem.detail).not.toContain('raw provider text');
  });

  it('collapses unknown and missing codes to INTERNAL_ERROR', () => {
    expect(fromLegacyError({ error: 'nope', code: 'SOME_LOCAL_CODE' }).code).toBe('INTERNAL_ERROR');
    expect(fromLegacyError({ error: 'nope' }).code).toBe('INTERNAL_ERROR');
    expect(fromLegacyError('plain string failure').code).toBe('INTERNAL_ERROR');
  });

  it('returns a safe user message for any error shape', () => {
    expect(problemUserMessage({ code: 'RATE_LIMITED', error: 'raw' })).toBe(
      PROBLEM_DEFINITIONS.RATE_LIMITED.detail,
    );
    expect(problemUserMessage({ error: 'raw provider text' })).toBe(
      PROBLEM_DEFINITIONS.INTERNAL_ERROR.detail,
    );
  });
});

describe('Problem Details Taxonomy — wired route (/api/affiliates/earnings)', () => {
  function request(query = ''): NextRequest {
    return new NextRequest(`http://localhost:3000/api/affiliates/earnings${query}`);
  }

  it('returns WALLET_REQUIRED when the wallet is missing', async () => {
    const response = await getEarnings(request());
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const body = await response.json();
    expect(body.code).toBe('WALLET_REQUIRED');
    expect(body.error).toBe(body.detail);
    expect(body.remediation).toBeTruthy();
  });

  it('returns INVALID_WALLET_ADDRESS for a malformed wallet', async () => {
    const response = await getEarnings(request('?wallet=0xnotstellar'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INVALID_WALLET_ADDRESS');
  });

  it('returns INVALID_RANGE for an out-of-bounds days value', async () => {
    const wallet = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    const response = await getEarnings(request(`?wallet=${wallet}&days=9999`));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('INVALID_RANGE');
  });

  it('keeps the success payload unchanged', async () => {
    const wallet = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    const response = await getEarnings(request(`?wallet=${wallet}&days=30`));
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });
});
