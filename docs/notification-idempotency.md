# Notification and webhook duplicate suppression

Lifecycle notifications deduplicate by `dedupKey` for 24 hours. The key map is
bounded to 10,000 entries and evicts the oldest expirations when full. A
repeated event inside the window returns `isDuplicate: true` and does not create
a second notification. After the window expires, a new event with the same key
can be delivered again.

Signed webhooks deduplicate by the signing-secret scope and event ID. The
retention matches the configured signature replay window (five minutes by
default), so a duplicate event ID from another signing secret is independent.
The existing timestamp check still rejects stale webhooks after that window.
Invalid signatures are never added to the duplicate registry.

Both registries are process-local. They protect retries handled by the same
server process and are not a distributed exactly-once guarantee across replicas
or restarts. Deployments that need cross-replica suppression should persist
webhook event IDs and notification idempotency keys in the shared datastore
before enabling side effects. Until then, downstream effects must remain
idempotent and consumers must not treat a `202`/enqueue response as proof of
delivery.

Related checks:

- `tests/__tests__/webhook-verification.test.ts` covers duplicate, expired,
  and per-secret event IDs.
- `tests/__tests__/lifecycle-notifications.test.ts` covers duplicate delivery
  and expiration of notification keys.
