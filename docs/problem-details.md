# API Problem Details & Error-Code Taxonomy

Every error Trellis API routes return is described once, in
`lib/api-contracts/problem-details.ts`, and rendered as an
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document with the
media type `application/problem+json`.

The registry — not the call site — owns the user-facing text. A raw provider,
contract, or stack message therefore cannot reach a client, and a client can
branch on `code` without parsing prose.

---

## Payload shape

```json
{
  "type": "https://github.com/TRELLIS-STELLAR/Trellis-frontend/blob/main/docs/problem-details.md#invalid-wallet-address",
  "title": "Invalid wallet address",
  "status": 400,
  "code": "INVALID_WALLET_ADDRESS",
  "detail": "The wallet address is not a valid Stellar public key.",
  "error": "The wallet address is not a valid Stellar public key.",
  "remediation": "Reconnect the intended wallet or paste a valid G... Stellar public key, then retry.",
  "retryable": false,
  "docs": "https://github.com/TRELLIS-STELLAR/Trellis-frontend/blob/main/docs/problem-details.md#invalid-wallet-address",
  "taxonomyVersion": "1",
  "instance": "/api/affiliates/earnings",
  "correlationId": "b738df0b-..."
}
```

- `code` is the contract. Branch on it, log it, and include it in support
  reports. Codes are stable and never reused.
- `error` duplicates `detail` so existing clients that read
  `payload.error` keep working. New clients should read `detail`.
- `remediation` is safe to render directly in the UI.
- `retryable: true` means an unchanged retry can plausibly succeed. `false`
  means the request or the wallet state must change first.
- `correlationId` pairs the response with protected diagnostic logs; it is
  also returned in the `X-Correlation-Id` response header.
- `taxonomyVersion` versions this contract. It is `1` today.

`docs/api-contracts.md` still describes the legacy
`{ error, code, details }` shape. Problem documents are a strict superset:
`error` and `code` are unchanged, so the migration is additive.

---

## Registry

Run `npm test -- problem-details` and the drift test fails the build if the
table below and `PROBLEM_DEFINITIONS` disagree, if a code lacks safe text, or
if an endpoint contract references a code that is not registered.

| Code | HTTP | Retryable | Meaning |
|------|------|-----------|---------|
| [`INVALID_REQUEST`](#invalid-request) | 400 | no | Request could not be understood |
| [`WALLET_REQUIRED`](#wallet-required) | 400 | no | A wallet address is required |
| [`INVALID_WALLET_ADDRESS`](#invalid-wallet-address) | 400 | no | Wallet is not a valid Stellar public key |
| [`INVALID_RANGE`](#invalid-range) | 400 | no | Numeric parameter outside the accepted range |
| [`MISSING_REQUIRED_FIELDS`](#missing-required-fields) | 400 | no | A required field was omitted |
| [`VALIDATION_FAILED`](#validation-failed) | 422 | no | Submitted values are invalid |
| [`NOT_FOUND`](#not-found) | 404 | no | Resource does not exist |
| [`CONFLICT`](#conflict) | 409 | yes | Request conflicts with current state |
| [`IDEMPOTENCY_CONFLICT`](#idempotency-conflict) | 409 | no | Idempotency key reused for a different request |
| [`RATE_LIMITED`](#rate-limited) | 429 | yes | Too many requests in a short window |
| [`UPSTREAM_UNAVAILABLE`](#upstream-unavailable) | 502 | yes | A required upstream is temporarily unavailable |
| [`INTERNAL_ERROR`](#internal-error) | 500 | yes | Unclassified server failure |

---

## Using the taxonomy

### Route handlers

```ts
import { createProblemResponse } from '@/lib/api-contracts/problem-details';

if (!wallet) {
  return createProblemResponse('WALLET_REQUIRED', { instance: request.nextUrl.pathname });
}
```

Do **not** build error bodies by hand. A hand-built body bypasses the safe
message registry and the drift tests.

### Clients

```ts
import {
  fromLegacyError,
  parseProblemDetails,
} from '@/lib/api-contracts/problem-details';

const problem = parseProblemDetails(await response.json());
if (problem) {
  showToast(problem.detail, { action: problem.remediation });
  if (problem.retryable) scheduleRetry();
} else {
  // Older server or non-Trellis error: fail safe, never render the raw body.
  showToast(fromLegacyError(await response.json()).detail);
}
```

---

## Operational edge cases & failure modes

| Situation | Behavior | Operator action |
|-----------|----------|-----------------|
| A route throws an unexpected error | `INTERNAL_ERROR` is returned; the raw error is logged only in protected diagnostics | Correlate the `correlationId` from support reports with server logs |
| A malformed JSON body is posted | The route's parser throws and the catch returns `INTERNAL_ERROR` (500), not a 400 | Callers should retry only after fixing the payload; consider adding a body-parse guard where this becomes common |
| A client sends an **unknown** `code` in a legacy payload | `fromLegacyError` collapses it to `INTERNAL_ERROR` rather than echoing the value | If a new code is genuinely needed, add it to the registry; never let a route invent one locally |
| Two problems could describe one failure | The most specific code wins (`INVALID_WALLET_ADDRESS` over `INVALID_REQUEST`) | Keep precedence stable; it is covered by route tests |
| The registry gains a code but `docs/problem-details.md` is not updated | The drift test fails | Add the row and any operational guidance in the same change |

### Recovery & rollback

The taxonomy is a pure presentation contract: it holds no state, writes
nothing, and can be rolled back by reverting the module and the routes that
use it. Because problem documents are additive over the legacy payload,
reverting the response helper restores byte-for-byte legacy behavior for
existing clients. Roll back the route changes, then the module, then re-run
`npm test -- problem-details api-contracts-drift` to confirm no contract test
still expects the new shape.

---

## Extending the taxonomy

1. Add the code to `PROBLEM_DEFINITIONS` with `status`, `title`, `detail`,
   `remediation`, and `retryable`.
2. Add the row to the registry table above.
3. Reference the code from the endpoint contract in
   `lib/api-contracts/schemas.ts` if the route documents an error response.
4. Run `npm test -- problem-details` — the drift test fails until the docs
   table, registry, and endpoint contracts agree.

**Never** rename or delete a released code, and never reuse one for a different
failure mode. Add a new code instead; `PROBLEM_CODES` preserves registry order
so generated catalogs stay stable.

---

## Tests

`tests/__tests__/problem-details.test.ts` enforces the contract:

- registry codes are unique and appear exactly once in the docs table;
- every definition has a valid HTTP status, non-empty safe text, and a docs
  link that matches its anchor;
- `createProblemResponse` sets the status, `application/problem+json`, and
  `X-Correlation-Id`;
- legacy payloads normalize without leaking their original message;
- every error code declared by an endpoint contract is registered;
- the wired route (`/api/affiliates/earnings`) returns problem documents for
  each validation failure while still exposing `error` and `code`.

---

## Related documents

- [`docs/api-contracts.md`](./api-contracts.md) — endpoint catalog and drift guide
- [`docs/client-error-handling.md`](./client-error-handling.md) — client-side error boundaries
- [`docs/incident-runbook.md`](./incident-runbook.md) — incident escalation
