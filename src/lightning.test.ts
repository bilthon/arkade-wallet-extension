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

/** A promise plus its resolve/reject, for controlling exactly when a mocked build settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
      // RELATIVE seconds (the raw BOLT11 expiry tag) — NOT an absolute Unix
      // timestamp, despite the library docstring. See createInvoice's comment.
      expiry: 3600,
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
  const cases: Array<[BoltzSwapStatus, LnReceiveStatus]> = [
    ['swap.created', 'waiting'],
    ['transaction.mempool', 'claiming'],
    ['transaction.confirmed', 'claiming'],
    ['invoice.settled', 'done'],
    // claimVHTLC's recoverable/joinBatch path persists this — a SUCCESS, not a failure.
    ['transaction.claimed', 'done'],
    ['invoice.expired', 'expired'],
    ['swap.expired', 'expired'],
    ['transaction.failed', 'failed'],
    ['transaction.refunded', 'failed'],
    // Statuses that never apply to a reverse swap default to the non-terminal
    // 'waiting' (self-heals via invoice expiry), NOT a misleading 'failed'.
    ['invoice.failedToPay', 'waiting'],
    ['invoice.paid', 'waiting'],
    ['invoice.pending', 'waiting'],
    ['invoice.set', 'waiting'],
    ['transaction.claim.pending', 'waiting'],
    ['transaction.lockupFailed', 'waiting'],
    ['transaction.server.mempool', 'waiting'],
    ['transaction.server.confirmed', 'waiting'],
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

  it('anchors the relative expiry to now as epoch ms, maps the swap id/receive amount, and never returns the preimage', async () => {
    const instance = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValue(instance);

    const before = Date.now();
    const result = await createInvoice(seed, { amount: 25_000 });
    const after = Date.now();

    const { expiresAt, ...rest } = result;
    expect(rest).toEqual({
      invoice: 'lnbc1invoice',
      paymentHash: 'deadbeef',
      swapId: 'swap-1',
      receiveAmount: 24_900,
    });
    // The library's `expiry` is a relative BOLT11 duration (3600s here); the
    // deadline must land ~an hour in the FUTURE, not at epoch 3600s (the bug
    // this pins down: a 1970 deadline made every invoice render as expired).
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3_600_000);
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

  it('rebuilds against the new network after a network change + disposeSwaps (the real switchNetwork flow)', async () => {
    // getSwaps no longer re-checks the network per call — a network change is
    // only ever observed via the switchNetwork handler's disposeSwaps() call.
    const first = fakeSwapInstance();
    const second = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    state.network = 'regtest';
    await getSwaps(seed);
    expect(state.createArkadeSwaps.mock.calls[0][0].swapRepository.dbName).toBe(
      'arkade-swaps-regtest',
    );

    state.network = 'mutinynet';
    await disposeSwaps();
    expect(first.dispose).toHaveBeenCalledOnce();

    const b = await getSwaps(seed);
    expect(b).toBe(second);
    expect(state.createArkadeSwaps.mock.calls[1][0].swapRepository.dbName).toBe(
      'arkade-swaps-mutinynet',
    );
  });

  it('throws LIGHTNING_UNAVAILABLE for a network with no Boltz endpoint, without building anything', async () => {
    state.network = 'testnet'; // NETWORK_CONFIG.testnet has no boltzApiUrl

    await expect(getSwaps(seed)).rejects.toThrow('LIGHTNING_UNAVAILABLE');
    expect(state.createArkadeSwaps).not.toHaveBeenCalled();
  });

  it('memoizes concurrent calls — ArkadeSwaps.create runs exactly once, both callers get the same instance', async () => {
    const instance = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValue(instance);

    const [a, b] = await Promise.all([getSwaps(seed), getSwaps(seed)]);

    expect(a).toBe(instance);
    expect(b).toBe(instance);
    expect(state.createArkadeSwaps).toHaveBeenCalledOnce();
  });

  it('self-destructs a build that finishes after a concurrent disposeSwaps, instead of leaking it', async () => {
    const first = fakeSwapInstance();
    const second = fakeSwapInstance();
    const gate = deferred<ReturnType<typeof fakeSwapInstance>>();
    state.createArkadeSwaps.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(second);

    const building = getSwaps(seed); // ArkadeSwaps.create is still pending (gate)

    await disposeSwaps(); // a lock (or switchNetwork) races the in-flight build

    gate.resolve(first); // the build finishes AFTER the dispose already landed
    await expect(building).rejects.toThrow('LOCKED');
    expect(first.dispose).toHaveBeenCalledOnce(); // self-destructed, not leaked

    // The memo was cleared by disposeSwaps, so the next call rebuilds cleanly.
    const b = await getSwaps(seed);
    expect(b).toBe(second);
    expect(state.createArkadeSwaps).toHaveBeenCalledTimes(2);
  });

  it('does not poison the memo on a failed build — the next getSwaps retries', async () => {
    state.createArkadeSwaps.mockRejectedValueOnce(new Error('boltz unreachable'));
    const instance = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValueOnce(instance);

    await expect(getSwaps(seed)).rejects.toThrow('boltz unreachable');
    await Promise.resolve(); // let the internal failure-handler clear the memo

    const b = await getSwaps(seed);
    expect(b).toBe(instance);
    expect(state.createArkadeSwaps).toHaveBeenCalledTimes(2);
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
