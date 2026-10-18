/**
 * API Problem Details Taxonomy
 *
 * One registry of stable machine-readable problem codes for every HTTP error
 * Trellis APIs return, rendered as RFC 9457 (`application/problem+json`)
 * documents. The registry — not the call site — owns the user-facing text, so
 * a raw provider, contract, or stack message can never leak into a response.
 *
 * Contract guarantees:
 *   - `code` values are stable. Released codes are never renamed or reused;
 *     analytics, support triage, and client retry logic key off them.
 *   - Every code carries a fixed HTTP status, title, safe `detail`, a
 *     remediation hint, a retryability flag, and a documentation link.
 *   - The legacy `{ error, code, details }` payload remains readable: the
 *     problem document still exposes `error` as an alias of `detail`, so
 *     existing clients do not break.
 *   - `taxonomyVersion` versions the contract itself. Bump it only on a
 *     breaking change and update the drift tests at the same time.
 *
 * This module is intentionally dependency-free and safe to import from both
 * route handlers (server) and client error boundaries.
 */

export const PROBLEM_TAXONOMY_VERSION = '1';

/**
 * Documentation anchor base. Per-code anchors are the lowercase kebab-case
 * form of the code, e.g. `INVALID_WALLET_ADDRESS` ->
 * `#invalid-wallet-address`.
 */
export const PROBLEM_DOCS_BASE =
  'https://github.com/TRELLIS-STELLAR/Trellis-frontend/blob/main/docs/problem-details.md';

export interface ProblemDefinition {
  /** HTTP status this problem always maps to. */
  status: number;
  /** Short, human-readable summary. */
  title: string;
  /** Safe user-facing explanation. Never contains raw error text. */
  detail: string;
  /** What the caller should do next. Safe to render in the UI. */
  remediation: string;
  /** Whether an unchanged retry can plausibly succeed. */
  retryable: boolean;
}

/**
 * The taxonomy. Order here is the documented order; `PROBLEM_CODES` preserves
 * it so generated docs and API catalogs stay stable.
 */
export const PROBLEM_DEFINITIONS = {
  INVALID_REQUEST: {
    status: 400,
    title: 'Invalid request',
    detail: 'The request could not be understood. Check the request and try again.',
    remediation: 'Correct the request and retry. When integrating against the API, check the endpoint contract in docs/api-contracts.md.',
    retryable: false,
  },
  WALLET_REQUIRED: {
    status: 400,
    title: 'Wallet address required',
    detail: 'A Stellar wallet address is required for this request.',
    remediation: 'Reconnect your wallet and retry, or supply the wallet query parameter.',
    retryable: false,
  },
  INVALID_WALLET_ADDRESS: {
    status: 400,
    title: 'Invalid wallet address',
    detail: 'The wallet address is not a valid Stellar public key.',
    remediation: 'Reconnect the intended wallet or paste a valid G... Stellar public key, then retry.',
    retryable: false,
  },
  INVALID_RANGE: {
    status: 400,
    title: 'Invalid range',
    detail: 'A numeric parameter is outside the accepted range.',
    remediation: 'Use a value within the documented range, then retry.',
    retryable: false,
  },
  MISSING_REQUIRED_FIELDS: {
    status: 400,
    title: 'Missing required fields',
    detail: 'One or more required fields are missing from the request.',
    remediation: 'Supply every required field for this endpoint, then retry.',
    retryable: false,
  },
  VALIDATION_FAILED: {
    status: 422,
    title: 'Validation failed',
    detail: 'Some submitted values are invalid.',
    remediation: 'Review the submitted values against the endpoint contract and submit again.',
    retryable: false,
  },
  NOT_FOUND: {
    status: 404,
    title: 'Not found',
    detail: 'The requested resource does not exist.',
    remediation: 'Check the identifier and retry. If the resource was removed, refresh the page.',
    retryable: false,
  },
  CONFLICT: {
    status: 409,
    title: 'Conflict',
    detail: 'The request conflicts with the current state of the resource.',
    remediation: 'Refresh to load the latest state, then retry.',
    retryable: true,
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    title: 'Idempotency conflict',
    detail: 'This idempotency key was already used for a different request.',
    remediation: 'Retry with the original request payload, or send a new idempotency key.',
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    title: 'Rate limited',
    detail: 'Too many requests were sent in a short period.',
    remediation: 'Wait for the Retry-After interval, then retry.',
    retryable: true,
  },
  UPSTREAM_UNAVAILABLE: {
    status: 502,
    title: 'Upstream unavailable',
    detail: 'A required upstream service is temporarily unavailable.',
    remediation: 'Retry shortly. If the failure persists, check status and share the correlation ID with support.',
    retryable: true,
  },
  INTERNAL_ERROR: {
    status: 500,
    title: 'Internal error',
    detail: 'We could not complete this request. Try again shortly.',
    remediation: 'Retry once, then share the correlation ID with support if the problem persists.',
    retryable: true,
  },
} as const satisfies Record<string, ProblemDefinition>;

export type ProblemCode = keyof typeof PROBLEM_DEFINITIONS;

/** Registry order, stable for documentation and contract tests. */
export const PROBLEM_CODES = Object.keys(PROBLEM_DEFINITIONS) as ProblemCode[];

export function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === 'string' && value in PROBLEM_DEFINITIONS;
}

export function getProblemDefinition(code: ProblemCode): ProblemDefinition {
  const definition: ProblemDefinition | undefined = PROBLEM_DEFINITIONS[code];
  if (!definition) {
    // A typo must fail loudly in development and tests instead of silently
    // degrading to a less specific problem.
    throw new Error(`Unknown problem code: ${String(code)}`);
  }
  return definition;
}

function anchorFor(code: ProblemCode): string {
  return code.toLowerCase().replace(/_/g, '-');
}

/** The stable, dereferenceable documentation URL for a code. */
export function problemDocsUrl(code: ProblemCode): string {
  return `${PROBLEM_DOCS_BASE}#${anchorFor(code)}`;
}

/** RFC 9457 `type` URI for a code. */
export function problemTypeUri(code: ProblemCode): string {
  return `${PROBLEM_DOCS_BASE}#${anchorFor(code)}`;
}

/**
 * An RFC 9457 problem document plus the Trellis extensions.
 *
 * `error` is retained deliberately: older clients read `payload.error` and
 * `payload.code`, and both continue to work.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  /** Stable machine-readable code. Primary client contract. */
  code: ProblemCode;
  /** Safe user-facing message (RFC 9457 `detail`). */
  detail: string;
  /** Legacy alias for `detail`, kept for backward compatibility. */
  error: string;
  remediation: string;
  retryable: boolean;
  docs: string;
  taxonomyVersion: string;
  /** Request path or resource the problem applies to, when known. */
  instance?: string;
  /** Support reference that can be paired with protected diagnostic logs. */
  correlationId?: string;
}

export interface ProblemOptions {
  /** Request path or resource identifier. */
  instance?: string;
  /** Support correlation id; generated when omitted by response helpers. */
  correlationId?: string;
}

function createCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `trellis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export { createCorrelationId as createProblemCorrelationId };

/**
 * Build a problem document from the registry. There is no message override
 * parameter on purpose: call sites choose a code, and the registry owns the
 * words, which is what keeps raw errors out of user-visible responses.
 */
export function createProblemDetails(code: ProblemCode, options: ProblemOptions = {}): ProblemDetails {
  const definition = getProblemDefinition(code);
  const details: ProblemDetails = {
    type: problemTypeUri(code),
    title: definition.title,
    status: definition.status,
    code,
    detail: definition.detail,
    error: definition.detail,
    remediation: definition.remediation,
    retryable: definition.retryable,
    docs: problemDocsUrl(code),
    taxonomyVersion: PROBLEM_TAXONOMY_VERSION,
  };
  if (options.instance) details.instance = options.instance;
  if (options.correlationId) details.correlationId = options.correlationId;
  return details;
}

/**
 * Build an `application/problem+json` response. Works with the Web `Response`
 * API used by Next.js App Router route handlers.
 */
export function createProblemResponse(code: ProblemCode, options: ProblemOptions = {}): Response {
  const correlationId = options.correlationId ?? createCorrelationId();
  const details = createProblemDetails(code, { ...options, correlationId });
  const headers: Record<string, string> = {
    'content-type': 'application/problem+json',
    'cache-control': 'no-store',
    'x-correlation-id': correlationId,
  };
  return new Response(JSON.stringify(details), { status: details.status, headers });
}

export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isProblemCode(candidate.code) &&
    typeof candidate.title === 'string' &&
    typeof candidate.status === 'number' &&
    typeof candidate.detail === 'string' &&
    typeof candidate.remediation === 'string' &&
    typeof candidate.docs === 'string' &&
    typeof candidate.retryable === 'boolean'
  );
}

/**
 * Parse an unknown payload (object or JSON string) into a validated problem
 * document. Returns `null` when the payload is not a problem document, so
 * callers can fall back to their own handling.
 */
export function parseProblemDetails(input: unknown): ProblemDetails | null {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isProblemDetails(value) ? value : null;
}

/**
 * Convert a legacy `{ error, code, details }` payload into a problem document.
 *
 * The legacy human message is intentionally discarded: only the stable code is
 * trusted. Unknown or missing codes collapse to `INTERNAL_ERROR` so a client
 * never receives unsanitized upstream text.
 */
export function fromLegacyError(
  payload: unknown,
  options: ProblemOptions = {},
): ProblemDetails {
  const record =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const rawCode = record.code ?? record.errorCode;
  if (isProblemCode(rawCode)) {
    return createProblemDetails(rawCode, options);
  }
  return createProblemDetails('INTERNAL_ERROR', options);
}

/** Safe user-facing message for any error-shaped value. */
export function problemUserMessage(payload: unknown, options: ProblemOptions = {}): string {
  const parsed = parseProblemDetails(payload);
  if (parsed) return parsed.detail;
  return fromLegacyError(payload, options).detail;
}
