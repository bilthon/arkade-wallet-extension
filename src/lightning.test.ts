import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkName } from '@arkade-os/sdk';
import type { BoltzSwapStatus } from '@arkade-os/boltz-swap';

/**
 * Lightning (Boltz reverse-swap) SW runtime tests.
 *
 * Module mocking strategy:
 *  • './storage' → `getNetwork` reads a controllable in-test value (defaults to
 *    'regtest'); `NETWORK_CONFIG`'s real per-network `boltzApiUrl` entries are
 *    exercised as-is via `importOriginal` on './wallet'.
 *  • './wallet' → `buildWallet` is replaced with a fake IWallet stub (no real
 *    SDK/IndexedDB construction); `networkConfig`/`NETWORK_CONFIG` pass through real.
 *  • '@arkade-os/boltz-swap' → `ArkadeSwaps.create`, `BoltzSwapProvider`, and
 *    `IndexedDbSwapRepository` are replaced with lightweight fakes (no WebSocket,
 *    no real IndexedDB); the pure status-predicate helpers (`isReverse*`) pass
 *    through real via `importOriginal` so `mapReverseStatus` exercises real logic.
 */

const state = vi.hoisted(() => ({
  network: 'regtest',
  repoSwaps: [] as Array<{ id: string; type: string; status: string }>,
  providerConstructions: [] as Array<{ apiUrl: string; network: string }>,
  createArkadeSwaps: vi.fn(),
  repoDisposeMock: vi.fn(async () => {}),
  providerGetFees: vi.fn(async () => ({
    submarine: { percentage: 0.1, minerFees: 100 },
    reverse: { percentage: 0.25, minerFees: { lockup: 150, claim: 172 } },
  })),
  providerGetLimits: vi.fn(async () => ({ min: 1000, max: 4_000_000 })),
}));

vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>();
  return { ...actual, getNetwork: vi.fn(async () => state.network as NetworkName) };
});

vi.mock('./wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wallet')>();
  return { ...actual, buildWallet: vi.fn(async () => ({ fakeWallet: true })) };
});

vi.mock('@arkade-os/boltz-swap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/boltz-swap')>();

  class FakeSwapProvider {
    constructor(public config: { apiUrl: string; network: string }) {
      state.providerConstructions.push(config);
    }
    getFees = state.providerGetFees;
    getLimits = state.providerGetLimits;
  }

  class FakeSwapRepository {
    constructor(public dbName: string) {}
    async getAllSwaps(filter?: { id?: string | string[]; type?: string | string[] }) {
      let out = state.repoSwaps;
      if (filter?.id) {
        const ids = Array.isArray(filter.id) ? filter.id : [filter.id];
        out = out.filter((s) => ids.includes(s.id));
      }
      if (filter?.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        out = out.filter((s) => types.includes(s.type));
      }
      return out;
    }
    // Present so a future accidental `await using`/dispose call fails loudly
    // instead of silently closing a "connection" tests can't observe.
    [Symbol.asyncDispose] = state.repoDisposeMock;
  }

  return {
    ...actual,
    ArkadeSwaps: { create: state.createArkadeSwaps },
    BoltzSwapProvider: FakeSwapProvider,
    IndexedDbSwapRepository: FakeSwapRepository,
  };
});

// Import AFTER vi.mock so the mocked modules are in place.
import {
  getSwaps,
  disposeSwaps,
  hasPendingSwaps,
  reconcilePendingSwaps,
  createInvoice,
  invoiceAmountForTarget,
  mapReverseStatus,
  getReceiveStatus,
  getLightningInfo,
  type LnReceiveStatus,
} from './lightning';

const seed = new Uint8Array(32).fill(7);

/** A fake `ArkadeSwaps` instance — only the surface `lightning.ts` calls. */
function fakeSwapInstance(overrides: Record<string, unknown> = {}) {
  return {
    dispose: vi.fn(async () => {}),
    getLimits: vi.fn(async () => ({ min: 1000, max: 1_000_000 })),
    createLightningInvoice: vi.fn(async ({ amount }: { amount: number }) => ({
      invoice: 'lnbc1invoice',
      paymentHash: 'deadbeef',
      preimage: 'super-secret-preimage',
      amount: amount - 100, // "after Boltz fees"
      expiry: 1_700_000_000, // Unix seconds
      pendingSwap: { id: 'swap-1' },
    })),
    refreshSwapsStatus: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(async () => {
  await disposeSwaps(); // module-level singleton must not leak across tests
  state.network = 'regtest';
  state.repoSwaps = [];
  state.providerConstructions = [];
  state.createArkadeSwaps.mockReset();
  state.repoDisposeMock.mockClear();
  state.providerGetFees.mockClear();
  state.providerGetLimits.mockClear();
});

describe('mapReverseStatus — full status table', () => {
  // isReverseClaimableStatus (mempool/confirmed) is a SUBSET of
  // isReversePendingStatus, so 'claiming' must win over 'waiting' for those two.
  const cases: Array<[BoltzSwapStatus, LnReceiveStatus]> = [
    ['swap.created', 'waiting'],
    ['transaction.mempool', 'claiming'],
    ['transaction.confirmed', 'claiming'],
    ['invoice.settled', 'done'],
    ['invoice.expired', 'expired'],
    ['swap.expired', 'expired'],
    ['transaction.failed', 'failed'],
    ['transaction.refunded', 'failed'],
    ['invoice.failedToPay', 'failed'],
    ['invoice.paid', 'failed'],
    ['invoice.pending', 'failed'],
    ['invoice.set', 'failed'],
    ['transaction.claim.pending', 'failed'],
    ['transaction.claimed', 'failed'],
    ['transaction.lockupFailed', 'failed'],
    ['transaction.server.mempool', 'failed'],
    ['transaction.server.confirmed', 'failed'],
  ];

  it.each(cases)('%s -> %s', (status, expected) => {
    expect(mapReverseStatus(status)).toBe(expected);
  });
});

describe('invoiceAmountForTarget', () => {
  it('is the identity when fees are zero', () => {
    expect(invoiceAmountForTarget(10_000, { percentage: 0, minerFeesTotal: 0 })).toBe(10_000);
  });

  it('round-trips within a sat or two: fees deducted from the invoice amount land at/above target', () => {
    const target = 25_000;
    const fees = { percentage: 0.25, minerFeesTotal: 402 };
    const invoiceAmount = invoiceAmountForTarget(target, fees);
    const landed = Math.floor(invoiceAmount * (1 - fees.percentage / 100)) - fees.minerFeesTotal;
    expect(landed).toBeGreaterThanOrEqual(target);
    expect(landed).toBeLessThanOrEqual(target + 2);
  });

  it('round-trips under a high fee (10% + 1000 sat miner fee)', () => {
    const target = 9_000;
    const fees = { percentage: 10, minerFeesTotal: 1_000 };
    const invoiceAmount = invoiceAmountForTarget(target, fees);
    const landed = Math.floor(invoiceAmount * (1 - fees.percentage / 100)) - fees.minerFeesTotal;
    expect(landed).toBeGreaterThanOrEqual(target);
    expect(landed).toBeLessThanOrEqual(target + 2);
  });
});

describe('createInvoice', () => {
  it('rejects an amount below the Boltz minimum with a clear message', async () => {
    state.createArkadeSwaps.mockResolvedValue(
      fakeSwapInstance({ getLimits: vi.fn(async () => ({ min: 1000, max: 1_000_000 })) }),
    );
    await expect(createInvoice(seed, { amount: 500 })).rejects.toThrow(
      /between 1000 and 1000000/i,
    );
  });

  it('rejects an amount above the Boltz maximum with a clear message', async () => {
    state.createArkadeSwaps.mockResolvedValue(
      fakeSwapInstance({ getLimits: vi.fn(async () => ({ min: 1000, max: 1_000_000 })) }),
    );
    await expect(createInvoice(seed, { amount: 2_000_000 })).rejects.toThrow(
      /between 1000 and 1000000/i,
    );
  });

  it('converts expiry to epoch ms, maps the swap id/receive amount, and never returns the preimage', async () => {
    const instance = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValue(instance);

    const result = await createInvoice(seed, { amount: 25_000 });

    expect(result).toEqual({
      invoice: 'lnbc1invoice',
      paymentHash: 'deadbeef',
      swapId: 'swap-1',
      receiveAmount: 24_900,
      expiresAt: 1_700_000_000_000,
    });
    expect(result).not.toHaveProperty('preimage');
    expect(JSON.stringify(result)).not.toContain('super-secret-preimage');
  });
});

describe('getSwaps — singleton lifecycle', () => {
  it('reuses the same instance for repeated calls on the same network', async () => {
    state.createArkadeSwaps.mockResolvedValue(fakeSwapInstance());

    const a = await getSwaps(seed);
    const b = await getSwaps(seed);

    expect(a).toBe(b);
    expect(state.createArkadeSwaps).toHaveBeenCalledOnce();
  });

  it('builds the repo/wallet with the per-network name and the rebuilt wallet', async () => {
    state.createArkadeSwaps.mockResolvedValue(fakeSwapInstance());

    await getSwaps(seed);

    const config = state.createArkadeSwaps.mock.calls[0][0];
    expect(config.wallet).toEqual({ fakeWallet: true });
    expect(config.swapRepository.dbName).toBe('arkade-swaps-regtest');
    expect(state.providerConstructions.at(-1)).toEqual({
      apiUrl: 'http://localhost:9069',
      network: 'regtest',
    });
  });

  it('rebuilds (and disposes the old one) after disposeSwaps', async () => {
    const first = fakeSwapInstance();
    const second = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const a = await getSwaps(seed);
    await disposeSwaps();
    expect(first.dispose).toHaveBeenCalledOnce();

    const b = await getSwaps(seed);
    expect(b).toBe(second);
    expect(b).not.toBe(a);
  });

  it('rebuilds when the active network changes underneath it', async () => {
    const first = fakeSwapInstance();
    const second = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    state.network = 'regtest';
    await getSwaps(seed);
    state.network = 'mutinynet';
    const b = await getSwaps(seed);

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(b).toBe(second);
  });

  it('throws LIGHTNING_UNAVAILABLE for a network with no Boltz endpoint, without building anything', async () => {
    state.network = 'testnet'; // NETWORK_CONFIG.testnet has no boltzApiUrl

    await expect(getSwaps(seed)).rejects.toThrow('LIGHTNING_UNAVAILABLE');
    expect(state.createArkadeSwaps).not.toHaveBeenCalled();
  });
});

describe('hasPendingSwaps', () => {
  it('is false with an empty repo', async () => {
    expect(await hasPendingSwaps('regtest')).toBe(false);
  });

  it('is true for a freshly-created swap', async () => {
    state.repoSwaps = [{ id: 'a', type: 'reverse', status: 'swap.created' }];
    expect(await hasPendingSwaps('regtest')).toBe(true);
  });

  it('is true for a claimable swap (mempool/confirmed are also "pending")', async () => {
    state.repoSwaps = [{ id: 'a', type: 'reverse', status: 'transaction.mempool' }];
    expect(await hasPendingSwaps('regtest')).toBe(true);
  });

  it('is false once the swap reached a terminal state', async () => {
    state.repoSwaps = [{ id: 'a', type: 'reverse', status: 'invoice.settled' }];
    expect(await hasPendingSwaps('regtest')).toBe(false);
  });

  it('ignores non-reverse swap types', async () => {
    state.repoSwaps = [{ id: 'a', type: 'submarine', status: 'invoice.set' }];
    expect(await hasPendingSwaps('regtest')).toBe(false);
  });

  it('never disposes the repository (would close the shared IndexedDB connection)', async () => {
    state.repoSwaps = [{ id: 'a', type: 'reverse', status: 'swap.created' }];
    await hasPendingSwaps('regtest');
    expect(state.repoDisposeMock).not.toHaveBeenCalled();
  });
});

describe('reconcilePendingSwaps', () => {
  it('builds the singleton and refreshes swap statuses (the manager auto-claims)', async () => {
    const instance = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValue(instance);

    await reconcilePendingSwaps(seed);

    expect(state.createArkadeSwaps).toHaveBeenCalledOnce();
    expect(instance.refreshSwapsStatus).toHaveBeenCalledOnce();
  });
});

describe('getLightningInfo', () => {
  it('returns available:false without constructing a provider when the network has no Boltz endpoint', async () => {
    state.network = 'testnet';

    expect(await getLightningInfo()).toEqual({ available: false });
    expect(state.providerConstructions).toHaveLength(0);
  });

  it('returns limits + summed reverse fees for a configured network', async () => {
    state.network = 'regtest';

    const result = await getLightningInfo();

    expect(result).toEqual({
      available: true,
      limits: { min: 1000, max: 4_000_000 },
      fees: { percentage: 0.25, minerFeesTotal: 322 }, // 150 (lockup) + 172 (claim)
    });
    expect(state.providerConstructions.at(-1)).toEqual({
      apiUrl: 'http://localhost:9069',
      network: 'regtest',
    });
  });
});

describe('getReceiveStatus', () => {
  it('maps a found swap through mapReverseStatus', async () => {
    state.repoSwaps = [{ id: 'swap-1', type: 'reverse', status: 'transaction.mempool' }];
    expect(await getReceiveStatus('swap-1')).toBe('claiming');
  });

  it('throws a clear, user-facing error when the swap is not found', async () => {
    state.repoSwaps = [];
    await expect(getReceiveStatus('missing')).rejects.toThrow(/could not be found/i);
  });

  it('never disposes the repository', async () => {
    state.repoSwaps = [{ id: 'swap-1', type: 'reverse', status: 'invoice.settled' }];
    await getReceiveStatus('swap-1');
    expect(state.repoDisposeMock).not.toHaveBeenCalled();
  });
});
