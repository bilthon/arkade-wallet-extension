import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CoinDelegationInfo, DelegationSettings } from './delegation-settings';
import type { CoinInfo } from './wallet';
import { CoinDelegationDetails, DelegationSummary } from '../entrypoints/popup/delegation-status';

describe('delegation status display', () => {
  const submittedAt = Date.UTC(2026, 8, 28, 12);

  it('shows accepted authorization time only in the badge tooltip', () => {
    const html = renderCoin({ status: 'delegated', submittedAt });
    expect(html).toContain('delegation-delegated');
    expect(html).toContain('Delegated');
    expect(html).toContain(`title="Accepted ${new Date(submittedAt).toLocaleString()}">Delegated</span>`);
    expect(html).not.toContain('<time');
    expect(html).not.toContain('Renewed');
  });

  it('shows failed attempt time and escapes the saved error text', () => {
    const html = renderCoin({ status: 'failed', attemptedAt: submittedAt, error: '<b>Retry later.</b>' });
    expect(html).toContain('delegation-failed');
    expect(html).toContain('Failed');
    expect(html).toContain('Last attempt');
    expect(html).toContain('dateTime="2026-09-28T12:00:00.000Z"');
    expect(html).toContain('&lt;b&gt;Retry later.&lt;/b&gt;');
  });

  it.each(['expired', 'recoverable'] as const)('hides accepted details for a %s coin', (state) => {
    expect(renderCoin({ status: 'delegated', submittedAt }, state)).toBe('');
    // A failed attempt still explains why this coin may need attention.
    expect(renderCoin({ status: 'failed', attemptedAt: submittedAt, error: 'Retry later.' }, state))
      .toContain('Retry later.');
  });

  it('labels pending and not configured with text as well as color', () => {
    expect(renderCoin({ status: 'pending' })).toContain('delegation-pending">Pending');
    const html = renderCoin({ status: 'not-configured', reason: 'Delegation is paused.' });
    expect(html).toContain('delegation-not-configured">Not configured');
    expect(html).toContain('Delegation is paused.');
  });

  it('does not mistake a missing snapshot entry for a not-configured coin', () => {
    const html = renderCoin(undefined);
    expect(html).toContain('Delegation status unavailable');
    expect(html).not.toContain('Not configured');
    expect(html).not.toContain('Delegated');
  });

  it('keeps accepted counts visible when paused', () => {
    const settings: DelegationSettings = {
      available: true, sessionId: 'session', endpoint: 'http://localhost:7012', coins: {},
      config: {
        enabled: false,
        delegate: { url: 'http://localhost:7012', pubkey: '02' + '11'.repeat(32), delegateAddress: 'address', fee: '0' },
      },
      summary: { delegated: 2, pending: 0, failed: 0, notConfigured: 3, totalSats: 5000, lastError: null },
    };
    const html = renderToStaticMarkup(createElement(DelegationSummary, { settings }));
    expect(html).toContain('Paused');
    expect(html).toContain('2 Delegated');
    expect(html).toContain('3 Not configured');
  });
});

function renderCoin(info: CoinDelegationInfo | undefined, state: CoinInfo['state'] = 'spendable'): string {
  return renderToStaticMarkup(createElement(CoinDelegationDetails, { info, state }));
}
