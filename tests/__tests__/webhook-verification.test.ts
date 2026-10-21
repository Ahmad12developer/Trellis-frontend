import { verifyWebhook, __resetProcessedWebhooks } from '@/lib/notifications/webhook';
import crypto from 'crypto';

describe('Webhook Verification', () => {
  const secret = 'test_secret';

  beforeEach(() => {
    __resetProcessedWebhooks();
  });

  const generateSignature = (payload: string, timestamp: string) => {
    return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  };

  it('validates a correct webhook', () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Date.now().toString();
    const eventId = 'evt_123';
    const signature = generateSignature(payload, timestamp);

    const headers = new Headers();
    headers.set('x-webhook-signature', signature);
    headers.set('x-webhook-timestamp', timestamp);
    headers.set('x-webhook-event-id', eventId);

    const result = verifyWebhook(payload, headers, { secret });
    expect(result.valid).toBe(true);
  });

  it('rejects invalid signature', () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Date.now().toString();
    const signature = generateSignature(payload, timestamp) + 'bad';

    const headers = new Headers();
    headers.set('x-webhook-signature', signature);
    headers.set('x-webhook-timestamp', timestamp);

    const result = verifyWebhook(payload, headers, { secret });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects stale timestamps outside window', () => {
    const payload = JSON.stringify({ event: 'test' });
    // 10 minutes ago (default max window is 5m)
    const timestamp = (Date.now() - 10 * 60 * 1000).toString();
    const signature = generateSignature(payload, timestamp);

    const headers = new Headers();
    headers.set('x-webhook-signature', signature);
    headers.set('x-webhook-timestamp', timestamp);

    const result = verifyWebhook(payload, headers, { secret });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('STALE_TIMESTAMP');
  });

  it('rejects missing headers', () => {
    const result1 = verifyWebhook('{}', new Headers(), { secret });
    expect(result1.valid).toBe(false);
    expect(result1.code).toBe('MISSING_SIGNATURE');

    const headers = new Headers();
    headers.set('x-webhook-signature', 'abc');
    const result2 = verifyWebhook('{}', headers, { secret });
    expect(result2.valid).toBe(false);
    expect(result2.code).toBe('MISSING_TIMESTAMP');
  });

  it('rejects duplicate event IDs', () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Date.now().toString();
    const eventId = 'evt_dup';
    const signature = generateSignature(payload, timestamp);

    const headers = new Headers();
    headers.set('x-webhook-signature', signature);
    headers.set('x-webhook-timestamp', timestamp);
    headers.set('x-webhook-event-id', eventId);

    // First request should be valid
    const result1 = verifyWebhook(payload, headers, { secret });
    expect(result1.valid).toBe(true);

    // Second request with same event ID should fail
    const result2 = verifyWebhook(payload, headers, { secret });
    expect(result2.valid).toBe(false);
    expect(result2.code).toBe('DUPLICATE_EVENT');
  });

  it('scopes duplicate IDs to the signing secret', () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Date.now().toString();
    const eventId = 'evt_shared';
    const headersFor = (signingSecret: string) => {
      const headers = new Headers();
      headers.set('x-webhook-signature', crypto.createHmac('sha256', signingSecret).update(`${timestamp}.${payload}`).digest('hex'));
      headers.set('x-webhook-timestamp', timestamp);
      headers.set('x-webhook-event-id', eventId);
      return headers;
    };

    expect(verifyWebhook(payload, headersFor(secret), { secret }).valid).toBe(true);
    const otherSecret = 'another_test_secret';
    expect(verifyWebhook(payload, headersFor(otherSecret), { secret: otherSecret }).valid).toBe(true);
  });

  it('expires duplicate IDs when the replay window ends', () => {
    const payload = JSON.stringify({ event: 'test' });
    let clock = 1_800_000_000_000;
    const eventId = 'evt_expiring';
    const send = () => {
      const timestamp = clock.toString();
      const headers = new Headers();
      headers.set('x-webhook-signature', generateSignature(payload, timestamp));
      headers.set('x-webhook-timestamp', timestamp);
      headers.set('x-webhook-event-id', eventId);
      return verifyWebhook(payload, headers, { secret, maxWindowMs: 1000, now: () => clock });
    };

    expect(send().valid).toBe(true);
    expect(send().code).toBe('DUPLICATE_EVENT');
    clock += 1001;
    expect(send().valid).toBe(true);
  });

  it('rejects malformed signature formats safely', () => {
    const payload = JSON.stringify({ event: 'test' });
    const timestamp = Date.now().toString();
    const signature = 'not-a-valid-hex-string!!!';

    const headers = new Headers();
    headers.set('x-webhook-signature', signature);
    headers.set('x-webhook-timestamp', timestamp);

    const result = verifyWebhook(payload, headers, { secret });
    expect(result.valid).toBe(false);
    expect(['INVALID_SIGNATURE', 'INVALID_SIGNATURE_FORMAT']).toContain(result.code);
  });
});
