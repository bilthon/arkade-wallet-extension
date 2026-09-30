import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DelegationMigrationReview } from './delegation-migration';

vi.mock('./messaging', () => ({ sendMessage: vi.fn() }));
import {
  DelegationExplanation, MigrationDetails, MigrationOutcome,
} from '../entrypoints/popup/screens/DelegationSettings';

const review: DelegationMigrationReview = {
  reviewId: 'review-1',
  inputs: [{ txid: 'ab'.repeat(32), vout: 2, value: 1234 }],
  amountSats: 1234, destination: 'approved-wallet-address', feeSats: 0,
};

describe('delegation approval and migration display', () => {
  it('explains onboarding, address changes, and the limits of offline renewal before approval', () => {
    const html = renderToStaticMarkup(createElement(DelegationExplanation));
    expect(html).toContain('automatic onboarding');
    expect(html).toContain('receiving address changes');
    expect(html).toContain('Existing addresses stay valid');
    expect(html).toContain('New or replacement coins need their own authorization');
    expect(html).toContain('Acceptance does not guarantee renewal');
    expect(html).toContain('delegate and the Arkade operator not colluding');
  });

  it('shows the exact reviewed inputs, own destination, amount, and cost', () => {
    const html = renderToStaticMarkup(createElement(MigrationDetails, { review }));
    expect(html).toContain(`${'ab'.repeat(32)}:2`);
    expect(html).toContain('1,234 sats');
    expect(html).toContain('approved-wallet-address');
    expect(html).toContain('0 sats');
    expect(html).toContain('checks these exact coins again before signing');
  });

  it('keeps transfer success distinct from failed or pending delegation', () => {
    const html = renderToStaticMarkup(createElement(MigrationOutcome, {
      result: { txid: 'cd'.repeat(32), delegationPending: true },
    }));
    expect(html).toContain('Funds moved');
    expect(html).toContain('cd'.repeat(32));
    expect(html).toContain('retry delegation without moving these funds again');
    expect(html).not.toContain('Confirm move');
  });
});
