import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ArkadeTransactionSummary } from './arkade-inspect';

vi.mock('./messaging', () => ({ sendMessage: vi.fn() }));
import { ArkadeTransactionBody } from '../entrypoints/approval/ApprovalPage';

const address = `bcrt1p${'q'.repeat(58)}`;
const summary: ArkadeTransactionSummary = {
  checkpointCount: 1,
  originalInputs: [{ index: 0, amount: 1000, role: 'contract', contract: {
    clause: 'cooperative', required: 3, signers: ['B', 'S', 'O'],
  } }],
  fee: 10,
  payment: {
    network: 'regtest',
    outputs: [
      { index: 0, address, amount: 900, isOwnChange: false },
      { index: 1, address: 'platform-address', amount: 90, isOwnChange: false },
    ],
    signInputs: [], totalLeaving: 1000, totalToExternal: 990, fee: 10,
    flags: ['SWEEP'], isContractCoSign: true, isPureContractCoSign: true,
  },
};

describe('linked Arkade approval', () => {
  it('shows each final payout in full, fee, original role and immediate authorization', () => {
    const html = renderToStaticMarkup(createElement(ArkadeTransactionBody, { summary, signCheckpoints: true }));
    expect(html.split(address)).toHaveLength(2);
    expect(html).toContain('platform-address');
    expect(html).toContain('900 sats');
    expect(html).toContain('90 sats');
    expect(html).toContain('Transaction fee: 10 sats');
    expect(html).toContain('Shared contract');
    expect(html).toContain('1 of 3 required signatures');
    expect(html).toContain('verified intermediate checkpoint');
    expect(html).toContain('signatures to this site immediately');
    expect(html).not.toContain('drains your wallet');
  });

  it('explains staged consent and retains a warning when signing own coins', () => {
    const html = renderToStaticMarkup(createElement(ArkadeTransactionBody, {
      summary: { ...summary, originalInputs: [{ index: 0, amount: 1000, role: 'own' }] },
      signCheckpoints: false,
    }));
    expect(html).toContain('without another prompt');
    expect(html).toContain('10 minutes');
    expect(html).toContain('Your wallet coin');
    expect(html).toContain('drains your wallet');
  });
});
