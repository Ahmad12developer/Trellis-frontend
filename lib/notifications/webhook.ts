import crypto from 'crypto';

export interface WebhookVerificationOptions {
  secret: string;
  maxWindowMs?: number;
  maxPayloadBytes?: number;
  /** Injectable clock for deterministic replay-window checks. */
  now?: () => number;
}

export interface WebhookVerificationResult {
  valid: boolean;
  error?: string;
  code?: 'MISSING_SIGNATURE' | 'MISSING_TIMESTAMP' | 'INVALID_TIMESTAMP' | 'STALE_TIMESTAMP' | 'DUPLICATE_EVENT' | 'INVALID_SIGNATURE' | 'INVALID_SIGNATURE_FORMAT' | 'PAYLOAD_TOO_LARGE' | 'INVALID_EVENT_ID';
}

const processedEventIds = new Map<string, number>();
export const DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES = 1_048_576;
const MAX_EVENT_ID_LENGTH = 200;
const MAX_PROCESSED_WEBHOOKS = 10_000;

export function verifyWebhook(
  payload: string,
  headers: Headers | { [key: string]: string | null | undefined },
  options: WebhookVerificationOptions
): WebhookVerificationResult {
  const getHeader = (name: string) => 
    typeof (headers as Headers).get === 'function' ? (headers as Headers).get(name) : (headers as any)[name];

  const signature = getHeader('x-webhook-signature');
  const timestampStr = getHeader('x-webhook-timestamp');
  const eventId = getHeader('x-webhook-event-id');

  if (!signature) return { valid: false, error: 'Missing signature', code: 'MISSING_SIGNATURE' };
  if (!timestampStr) return { valid: false, error: 'Missing timestamp', code: 'MISSING_TIMESTAMP' };

  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES;
  if (Buffer.byteLength(payload, 'utf8') > maxPayloadBytes) {
    return { valid: false, error: 'Webhook payload exceeds the allowed size', code: 'PAYLOAD_TOO_LARGE' };
  }
  if (eventId && eventId.length > MAX_EVENT_ID_LENGTH) {
    return { valid: false, error: 'Webhook event ID exceeds the allowed size', code: 'INVALID_EVENT_ID' };
  }
  
  if (!/^-?\d+$/.test(timestampStr)) return { valid: false, error: 'Invalid timestamp', code: 'INVALID_TIMESTAMP' };
  const timestamp = Number(timestampStr);
  if (!Number.isSafeInteger(timestamp)) return { valid: false, error: 'Invalid timestamp', code: 'INVALID_TIMESTAMP' };

  const now = options.now?.() ?? Date.now();
  const maxWindow = options.maxWindowMs ?? 5 * 60 * 1000; // 5 minutes default

  if (Math.abs(now - timestamp) > maxWindow) {
    return { valid: false, error: 'Webhook timestamp is outside the allowed window', code: 'STALE_TIMESTAMP' };
  }

  // Event IDs are scoped to the signing secret so independent webhook senders
  // cannot suppress each other's events by reusing an ID. The secret itself is
  // never retained; only a short digest is used in the in-memory key.
  const secretScope = crypto.createHash('sha256').update(options.secret).digest('hex').slice(0, 16);
  const processedKey = eventId ? `${secretScope}:${eventId}` : undefined;
  if (processedKey) {
    for (const [key, expiresAt] of processedEventIds) {
      if (expiresAt <= now) processedEventIds.delete(key);
    }
    if (processedEventIds.has(processedKey)) {
      return { valid: false, error: 'Duplicate webhook event', code: 'DUPLICATE_EVENT' };
    }
  }

  try {
    const expectedMac = crypto
      .createHmac('sha256', options.secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedMac, 'hex');
    const signatureBuffer = Buffer.from(signature, 'hex');

    if (
      expectedBuffer.length !== signatureBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
    ) {
      return { valid: false, error: 'Invalid signature', code: 'INVALID_SIGNATURE' };
    }
  } catch (err) {
    return { valid: false, error: 'Signature verification failed', code: 'INVALID_SIGNATURE_FORMAT' };
  }

  if (processedKey) {
    if (processedEventIds.size >= MAX_PROCESSED_WEBHOOKS) {
      const oldest = [...processedEventIds.entries()]
        .sort((left, right) => left[1] - right[1])
        .slice(0, Math.ceil(MAX_PROCESSED_WEBHOOKS * 0.1));
      oldest.forEach(([key]) => processedEventIds.delete(key));
    }
    // Dedupe retention matches the signature replay window. Expired timestamps
    // are rejected independently, so retaining their IDs longer adds no safety.
    processedEventIds.set(processedKey, now + maxWindow);
  }

  return { valid: true };
}

/** Test helper to reset state */
export function __resetProcessedWebhooks() {
  processedEventIds.clear();
}
