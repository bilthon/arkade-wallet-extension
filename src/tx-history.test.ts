import { describe, it, expect } from 'vitest';
import { toHistoryItem } from './wallet';

/**
 * Pure unit tests for `toHistoryItem` — no mocking, no wallet/operator.
 * Exercises every classification branch: deposit, withdrawal, ark-sent,
 * ark-received, fallback, settled/pending, and negative-amount normalisation.
 *
 * We build plain objects and cast them to avoid pulling in the TxType enum at
 * runtime (the same reason toHistoryItem compares tx.type as a string literal).
 */

/** Minimal ArkTransaction fixture. Unset keys default to empty string. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tx(overrides: Record<string, any>) {
  return {
    key: { boardingTxid: '', commitmentTxid: '', arkTxid: '' },
    type: 'RECEIVED',
    amount: 1000,
    settled: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  // Cast via unknown so the TxType enum mismatch doesn't block the test build.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('toHistoryItem — kind classification', () => {
  it('RECEIVED + boardingTxid → deposit, incoming, txid = boardingTxid', () => {
    const item = toHistoryItem(
      tx({ type: 'RECEIVED', key: { boardingTxid: 'abc123', commitmentTxid: '', arkTxid: '' } }),
    );
    expect(item.kind).toBe('deposit');
    expect(item.incoming).toBe(true);
    expect(item.txid).toBe('abc123');
  });

  it('SENT + commitmentTxid + no arkTxid → withdrawal, !incoming, txid = commitmentTxid', () => {
    const item = toHistoryItem(
      tx({ type: 'SENT', key: { boardingTxid: '', commitmentTxid: 'cmt456', arkTxid: '' } }),
    );
    expect(item.kind).toBe('withdrawal');
    expect(item.incoming).toBe(false);
    expect(item.txid).toBe('cmt456');
  });

  it('SENT + arkTxid → sent, !incoming, txid = arkTxid', () => {
    const item = toHistoryItem(
      tx({ type: 'SENT', key: { boardingTxid: '', commitmentTxid: '', arkTxid: 'ark789' } }),
    );
    expect(item.kind).toBe('sent');
    expect(item.incoming).toBe(false);
    expect(item.txid).toBe('ark789');
  });

  it('RECEIVED + arkTxid → received, incoming, txid = arkTxid', () => {
    const item = toHistoryItem(
      tx({ type: 'RECEIVED', key: { boardingTxid: '', commitmentTxid: '', arkTxid: 'ark000' } }),
    );
    expect(item.kind).toBe('received');
    expect(item.incoming).toBe(true);
    expect(item.txid).toBe('ark000');
  });

  it('RECEIVED + commitmentTxid only (batch receive) → received, incoming, txid = commitmentTxid', () => {
    // Real SDK shape: a batch/settlement credit carries only the commitment txid.
    const item = toHistoryItem(
      tx({ type: 'RECEIVED', key: { boardingTxid: '', commitmentTxid: 'cmt789', arkTxid: '' } }),
    );
    expect(item.kind).toBe('received');
    expect(item.incoming).toBe(true);
    expect(item.txid).toBe('cmt789');
  });

  it('fallback RECEIVED with no keys → received, incoming, txid = empty', () => {
    const item = toHistoryItem(
      tx({ type: 'RECEIVED', key: { boardingTxid: '', commitmentTxid: '', arkTxid: '' } }),
    );
    expect(item.kind).toBe('received');
    expect(item.incoming).toBe(true);
    expect(item.txid).toBe('');
  });

  it('fallback SENT with no keys → sent, !incoming, txid = empty', () => {
    const item = toHistoryItem(
      tx({ type: 'SENT', key: { boardingTxid: '', commitmentTxid: '', arkTxid: '' } }),
    );
    expect(item.kind).toBe('sent');
    expect(item.incoming).toBe(false);
    expect(item.txid).toBe('');
  });
});

describe('toHistoryItem — settled / pending', () => {
  it('preserves settled: true', () => {
    expect(toHistoryItem(tx({ settled: true })).settled).toBe(true);
  });

  it('preserves settled: false (pending)', () => {
    expect(toHistoryItem(tx({ settled: false })).settled).toBe(false);
  });
});

describe('toHistoryItem — amount normalisation', () => {
  it('positive amount is preserved as-is', () => {
    expect(toHistoryItem(tx({ amount: 5000 })).amount).toBe(5000);
  });

  it('negative amount → absolute magnitude', () => {
    expect(toHistoryItem(tx({ type: 'SENT', amount: -3000 })).amount).toBe(3000);
  });

  it('createdAt is passed through unchanged', () => {
    const ts = 1_234_567_890_123;
    expect(toHistoryItem(tx({ createdAt: ts })).createdAt).toBe(ts);
  });
});
