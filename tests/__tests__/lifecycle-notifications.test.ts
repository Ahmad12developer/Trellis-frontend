import { lifecycleNotifications } from '@/lib/notifications/lifecycle-manager';

describe('Lifecycle Notification System (Issue #40)', () => {
  beforeEach(() => {
    lifecycleNotifications.clear();
  });

  it('dispatches notifications and enforces deduplication for retried events', () => {
    const event = {
      dedupKey: 'tx_failed_0xabc123',
      type: 'transaction_failed' as const,
      title: 'Transaction Failed',
      message: 'Soroban contract execution halted due to timeout',
      severity: 'critical' as const,
      recipientWallet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      audience: 'user' as const,
      recoveryAction: {
        label: 'Retry with Higher Fee',
        actionId: 'retry_tx',
        href: '/simulations/reload/tx-1',
      },
    };

    // First dispatch -> success
    const res1 = lifecycleNotifications.dispatch(event);
    expect(res1.isDuplicate).toBe(false);
    expect(res1.notification).toBeDefined();
    expect(res1.notification?.title).toBe('Transaction Failed');

    // Second dispatch with same dedupKey -> flagged as duplicate and not recreated
    const res2 = lifecycleNotifications.dispatch(event);
    expect(res2.isDuplicate).toBe(true);
    expect(res2.notification).toBeNull();

    const userNotifs = lifecycleNotifications.getForUser('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    expect(userNotifs.length).toBe(1);
  });

  it('expires duplicate keys after the retention window', () => {
    const event = {
      dedupKey: 'scheduled-summary-2026-01-01',
      type: 'simulation_completed' as const,
      title: 'Simulation complete',
      message: 'The simulation finished.',
      severity: 'success' as const,
    };
    const firstTime = new Date('2026-01-01T00:00:00.000Z');

    expect(lifecycleNotifications.dispatch(event, { now: firstTime }).isDuplicate).toBe(false);
    expect(lifecycleNotifications.dispatch(event, { now: firstTime }).isDuplicate).toBe(true);
    expect(lifecycleNotifications.dispatch(event, {
      now: new Date(firstTime.getTime() + 24 * 60 * 60 * 1000 + 1),
    }).isDuplicate).toBe(false);
  });

  it('isolates recipient notifications and prevents data leakage across users', () => {
    const userA = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    const userB = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GIOVPXRKVKE544EOXY2S';

    lifecycleNotifications.dispatch({
      type: 'approval_required',
      title: 'Private Approval for User A',
      message: 'Confidential trade authorization',
      severity: 'warning',
      recipientWallet: userA,
      audience: 'user',
    });

    lifecycleNotifications.dispatch({
      type: 'security_audit_alert',
      title: 'Public Platform Announcement',
      message: 'Maintenance scheduled',
      severity: 'info',
      audience: 'all',
    });

    const notifsForA = lifecycleNotifications.getForUser(userA);
    const notifsForB = lifecycleNotifications.getForUser(userB);

    expect(notifsForA.some((n) => n.title === 'Private Approval for User A')).toBe(true);
    expect(notifsForA.some((n) => n.title === 'Public Platform Announcement')).toBe(true);
    expect(notifsForA.length).toBe(2);

    // User B should ONLY see the public notification, NOT User A's private alert
    expect(notifsForB.some((n) => n.title === 'Private Approval for User A')).toBe(false);
    expect(notifsForB.some((n) => n.title === 'Public Platform Announcement')).toBe(true);
    expect(notifsForB.length).toBe(1);
  });

  it('manages read / unread states and dismissal', () => {
    const user = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    const { notification } = lifecycleNotifications.dispatch({
      type: 'agent_minted',
      title: 'Agent Minted',
      message: 'Yield Bot #42 has been minted',
      severity: 'success',
      recipientWallet: user,
      audience: 'user',
    });

    expect(lifecycleNotifications.getForUser(user, { unreadOnly: true }).length).toBe(1);

    // Mark as read
    lifecycleNotifications.markAsRead(notification!.id);
    expect(lifecycleNotifications.getForUser(user, { unreadOnly: true }).length).toBe(0);
    expect(lifecycleNotifications.getForUser(user).length).toBe(1);

    // Dismiss
    lifecycleNotifications.dismiss(notification!.id);
    expect(lifecycleNotifications.getForUser(user).length).toBe(0);
  });
});
