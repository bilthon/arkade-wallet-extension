import { describe, it, expect, vi } from 'vitest';
import { ArkAddress, type ExtendedVirtualCoin, type Wallet } from '@arkade-os/sdk';
import {
  NETWORK_CONFIG,
  networkConfig,
  recoverExpiredVtxos,
  renewExpiringVtxos,
  send,
} from './wallet';
import type { SessionContext } from './wallet-runtime';

/**
 * The network → operator/esplora/derivation mapping is the one piece
 * of `wallet.ts` with branching logic worth pinning (the rest is thin SDK
 * pass-through exercised live against nigiri). We assert the regtest defaults
 * (arkd :7070, electrs REST :30000, testnet derivation) and that
 * mainnet is the only `isMainnet: true` network.
 */
describe('network config mapping', () => {
  it('maps regtest to nigiri local services with testnet derivation', () => {
    const cfg = networkConfig('regtest');
    expect(cfg.arkServerUrl).toBe('http://localhost:7070');
    expect(cfg.esploraUrl).toBe('http://localhost:30000');
    expect(cfg.isMainnet).toBe(false);
  });

  it('only mainnet derives as mainnet (BIP86 coin type 0)', () => {
    expect(networkConfig('bitcoin').isMainnet).toBe(true);
    for (const name of ['regtest', 'mutinynet', 'signet', 'testnet'] as const) {
      expect(networkConfig(name).isMainnet).toBe(false);
    }
  });

  it('covers every NetworkName with a non-empty operator + esplora URL', () => {
    for (const [name, cfg] of Object.entries(NETWORK_CONFIG)) {
      expect(cfg.arkServerUrl, `${name} arkServerUrl`).toMatch(/^https?:\/\//);
      expect(cfg.esploraUrl, `${name} esploraUrl`).toMatch(/^https?:\/\//);
    }
  });
});

/**
 * The protocol-critical recover-BEFORE-renew ordering.
 *
 * `renewVtxos` re-derives its own broad input set (it ignores any filter we compute), so
 * the only way to keep already-expired/swept coins out of the renew round is to drain
 * them via `recoverVtxos` FIRST. This pins that sequencing against a mocked VtxoManager
 * so a future refactor can't silently reorder or drop the recover-first guard.
 */
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const MARGIN = 8 * 60 * 1000;

function coin(opts: {
  value?: number;
  state?: 'preconfirmed' | 'settled' | 'swept' | 'spent';
  expiryMs?: number;
  isSpent?: boolean;
  txid?: string;
}): ExtendedVirtualCoin {
  const { value = 70_000, state = 'settled', expiryMs, isSpent = false, txid = 'tx' } = opts;
  return {
    txid,
    vout: 0,
    value,
    isSpent,
    virtualStatus: { state, batchExpiry: expiryMs },
  } as unknown as ExtendedVirtualCoin;
}

/** A mock Wallet whose VtxoManager records the order of recover/renew calls. */
function mockWallet(vtxos: ExtendedVirtualCoin[]) {
  const calls: string[] = [];
  const manager = {
    recoverVtxos: vi.fn(async () => {
      calls.push('recover');
      return 'recover-txid';
    }),
    renewVtxos: vi.fn(async () => {
      calls.push('renew');
      return 'renew-txid';
    }),
    dispose: vi.fn(async () => {}),
  };
  const wallet = {
    getVtxos: vi.fn(async () => vtxos),
    getVtxoManager: vi.fn(async () => manager),
  } as unknown as Wallet;
  return { wallet, manager, calls };
}

function context(wallet: Wallet, assertCurrent: () => void = vi.fn()): SessionContext {
  return { wallet, network: 'regtest', epoch: 1, assertCurrent };
}

const TARK = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark')
  .encode();

describe('wallet mutation authorization', () => {
  it('does not start a normal send after its balance read invalidates the context', async () => {
    let current = true;
    const sendMutation = vi.fn();
    const wallet = {
      getBalance: vi.fn(async () => ({
        boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
        settled: 10_000,
        preconfirmed: 0,
        available: 10_000,
        recoverable: 0,
        pendingRecovery: 0,
        total: 10_000,
        assets: [],
      })),
      getVtxos: vi.fn(async () => {
        current = false;
        return [];
      }),
      send: sendMutation,
    } as unknown as Wallet;
    const ctx = context(wallet, () => {
      if (!current) throw new Error('LOCKED');
    });

    await expect(send(ctx, { address: TARK, amount: 1_000 })).rejects.toThrow('LOCKED');
    expect(sendMutation).not.toHaveBeenCalled();
  });

  it('does not start a coin-control send after coin selection invalidates the context', async () => {
    let current = true;
    const sendBitcoin = vi.fn();
    const selected = coin({ expiryMs: NOW + HOUR, txid: 'selected' });
    const wallet = {
      getVtxos: vi.fn(async () => {
        current = false;
        return [selected];
      }),
      sendBitcoin,
    } as unknown as Wallet;
    const ctx = context(wallet, () => {
      if (!current) throw new Error('LOCKED');
    });

    await expect(
      send(ctx, { address: TARK, amount: 1_000, outpoints: ['selected:0'] }),
    ).rejects.toThrow('LOCKED');
    expect(sendBitcoin).not.toHaveBeenCalled();
  });

  it('does not start recovery after its balance probe invalidates the context', async () => {
    let current = true;
    const recoverVtxos = vi.fn();
    const wallet = {
      getVtxoManager: vi.fn(async () => ({
        getRecoverableBalance: vi.fn(async () => {
          current = false;
          return { vtxoCount: 1, recoverable: 5_000n };
        }),
        recoverVtxos,
      })),
    } as unknown as Wallet;
    const ctx = context(wallet, () => {
      if (!current) throw new Error('LOCKED');
    });

    await expect(recoverExpiredVtxos(ctx)).rejects.toThrow('LOCKED');
    expect(recoverVtxos).not.toHaveBeenCalled();
  });
});

describe('renewExpiringVtxos — recover-before-renew ordering', () => {
  it('recovers FIRST, then renews, when a poisoning coin coexists with a renewable one', async () => {
    const renewable = coin({ expiryMs: NOW + 5 * 60 * 1000, txid: 'soon' });
    const expired = coin({ expiryMs: NOW - HOUR, txid: 'expired' }); // poisons renew
    const { wallet, manager, calls } = mockWallet([renewable, expired]);

    const res = await renewExpiringVtxos(context(wallet), MARGIN);

    expect(calls).toEqual(['recover', 'renew']); // order is load-bearing
    expect(manager.recoverVtxos).toHaveBeenCalledOnce();
    expect(manager.renewVtxos).toHaveBeenCalledOnce();
    expect(res.renewed).toBe(1); // only the renewable coin counts
    // The manager stays cached on the wallet; the session runtime owns its lifetime.
    expect(manager.dispose).not.toHaveBeenCalled();
  });

  it('skips the recover drain when nothing is poisoning (only live + expiring-soon)', async () => {
    const renewable = coin({ expiryMs: NOW + 5 * 60 * 1000, txid: 'soon' });
    const live = coin({ expiryMs: NOW + 5 * HOUR, txid: 'live' });
    const { wallet, manager, calls } = mockWallet([renewable, live]);

    await renewExpiringVtxos(context(wallet), MARGIN);

    expect(calls).toEqual(['renew']); // no recover round needed
    expect(manager.recoverVtxos).not.toHaveBeenCalled();
  });

  it('is a no-op (no manager work) when nothing is renewable', async () => {
    const expired = coin({ expiryMs: NOW - HOUR, txid: 'expired' });
    const { wallet, manager } = mockWallet([expired]);

    const res = await renewExpiringVtxos(context(wallet), MARGIN);

    expect(res.renewed).toBe(0);
    expect(manager.recoverVtxos).not.toHaveBeenCalled();
    expect(manager.renewVtxos).not.toHaveBeenCalled();
  });

  it('propagates LOCKED without starting a renewal round for a stale context', async () => {
    const renewable = coin({ expiryMs: NOW + 5 * 60 * 1000, txid: 'soon' });
    const { wallet, manager } = mockWallet([renewable]);
    const assertCurrent = vi.fn(() => {
      throw new Error('LOCKED');
    });

    await expect(renewExpiringVtxos(context(wallet, assertCurrent), MARGIN)).rejects.toThrow(
      'LOCKED',
    );
    expect(manager.renewVtxos).not.toHaveBeenCalled();
  });
});
