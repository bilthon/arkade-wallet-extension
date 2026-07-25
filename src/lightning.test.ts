import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkName } from '@arkade-os/sdk';
import type { BoltzSwapStatus } from '@arkade-os/boltz-swap';

/**
 * Lightning (Boltz reverse-swap) SW runtime tests.
 *
 * Module mocking strategy:
 *  • './storage' → `getNetwork` reads a controllable in-test value (defaults to
 *    'regtest'). './wallet' itself is NOT mocked: `networkConfig`/`NETWORK_CONFIG`
 *    are a pure lookup table, safe to run for real, and lightning.ts no longer
 *    builds a wallet through that module.
 *  • './wallet-runtime' → `getSessionWallet` is a fake that mirrors the real
 *    module's memoization (one build per session, shared by concurrent callers,
 *    cleared by `invalidateSessionWallet`), so tests can exercise the same
 *    sharing behavior lightning.ts now relies on. `ensureFreshVtxos` is a bare mock.
 *  • '@arkade-os/boltz-swap' → `ArkadeSwaps.create`, `BoltzSwapProvider`, and
 *    `IndexedDbSwapRepository` are replaced with lightweight fakes (no WebSocket,
 *    no real IndexedDB); the pure status-predicate helpers (`isReverse*`) pass
 *    through real via `importOriginal` so `mapReverseStatus` exercises real logic.
 */

const state = vi.hoisted(() => ({
  network: 'regtest',
  repoSwaps: [] as Array<{
    id: string;
    type: string;
    status: string;
    refunded?: boolean;
    refundable?: boolean;
  }>,
  providerConstructions: [] as Array<{ apiUrl: string; network: string }>,
  createArkadeSwaps: vi.fn(),
  repoDisposeMock: vi.fn(async () => {}),
  providerGetFees: vi.fn(async () => ({
    submarine: { percentage: 0.1, minerFees: 100 },
    reverse: { percentage: 0.25, minerFees: { lockup: 150, claim: 172 } },
  })),
  providerGetLimits: vi.fn(async () => ({ min: 1000, max: 4_000_000 })),
  // The fake wallet's Arkade send — payInvoice funds the swap's VHTLC with it.
  walletSend: vi.fn(async () => 'ark-funding-txid'),
  // The fake session wallet's lifecycle, mirroring wallet-runtime.ts's own module
  // memory: one resolved wallet, one in-flight build shared by concurrent callers,
  // and a count so tests can assert how many times a build actually happened.
  currentWallet: null as FakeWallet | null,
  pendingWallet: null as Promise<FakeWallet> | null,
  walletBuildCount: 0,
  invalidateSessionWalletMock: vi.fn(),
  ensureFreshVtxosMock: vi.fn(async (_wallet: unknown) => {}),
}));

/** The fake session wallet's shape — only the surface `lightning.ts` calls. Named
 * explicitly (rather than inferred from `makeFakeWallet`'s return type) so `state`'s
 * own type doesn't depend on a function that itself reads `state`. */
interface FakeWallet {
  fakeWallet: true;
  send: (...args: unknown[]) => Promise<string>;
  arkProvider: { getInfo: () => Promise<{ network: string; signerPubkey: string }> };
}

vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>();
  return { ...actual, getNetwork: vi.fn(async () => state.network as NetworkName) };
});

function makeFakeWallet(): FakeWallet {
  return {
    fakeWallet: true,
    send: state.walletSend,
    arkProvider: {
      getInfo: async () => ({ network: 'regtest', signerPubkey: '02'.padEnd(66, 'a') }),
    },
  };
}

/**
 * Mirrors `wallet-runtime.ts`'s own memoization: a resolved wallet is reused, and
 * concurrent callers before that share the one in-flight build, so tests can pin
 * "only one Arkade wallet build" the same way the real runtime guarantees it.
 */
function fakeGetSessionWallet() {
  if (state.pendingWallet) return state.pendingWallet;
  if (state.currentWallet) return Promise.resolve(state.currentWallet);
  const mine = (async () => {
    state.walletBuildCount++;
    const wallet = makeFakeWallet();
    state.currentWallet = wallet;
    return wallet;
  })();
  state.pendingWallet = mine;
  const clear = () => {
    if (state.pendingWallet === mine) state.pendingWallet = null;
  };
  mine.then(clear, clear);
  return mine;
}

async function fakeInvalidateSessionWallet() {
  state.invalidateSessionWalletMock();
  state.currentWallet = null;
  state.pendingWallet = null;
}

vi.mock('./wallet-runtime', () => ({
  getSessionWallet: () => fakeGetSessionWallet(),
  invalidateSessionWallet: () => fakeInvalidateSessionWallet(),
  ensureFreshVtxos: (wallet: unknown) => state.ensureFreshVtxosMock(wallet),
}));

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
  mapReverseStatus,
  getReceiveStatus,
  getLightningInfo,
  getPayQuote,
  payInvoice,
  payTotalSlack,
  mapSubmarineStatus,
  getPayStatus,
} from './lightning';
import {
  invoiceAmountForTarget,
  submarineFeeForAmount,
  type LnPayStatus,
  type LnReceiveStatus,
} from './lightning-utils';
import { getSessionWallet, invalidateSessionWallet } from './wallet-runtime';

const seed = new Uint8Array(32).fill(7);

// Real BOLT11 spec test vectors (decoded by the REAL `decodeInvoice`, which the
// boltz-swap mock passes through via importOriginal):
//  • INVOICE_250K — "1 cup coffee", 2500u = 250 000 sats.
//  • INVOICE_AMOUNTLESS — the "Please make a donation" vector, no amount tag.
const INVOICE_250K =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const INVOICE_AMOUNTLESS =
  'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w';

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
    createSubmarineSwap: vi.fn(async () => ({
      id: 'sub-1',
      type: 'submarine',
      status: 'invoice.set',
      request: { invoice: INVOICE_250K, refundPublicKey: '03'.padEnd(66, 'b') },
      response: {
        address: 'tark1lockup',
        expectedAmount: 250_350,
        claimPublicKey: '02'.padEnd(66, 'c'),
        timeoutBlockHeights: {
          refund: 0,
          unilateralClaim: 0,
          unilateralRefund: 0,
          unilateralRefundWithoutReceiver: 0,
        },
      },
    })),
    // The reconstructed VHTLC matches Boltz's lockup address on the happy path,
    // so the address guard passes. Tests that want a mismatch override this.
    createVHTLCScript: vi.fn(() => ({ vhtlcAddress: 'tark1lockup' })),
    recoverAllSubmarineFunds: vi.fn(async () => []),
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
  state.providerGetLimits.mockResolvedValue({ min: 1000, max: 4_000_000 });
  state.walletSend.mockReset();
  state.walletSend.mockResolvedValue('ark-funding-txid');
  // The fake session wallet must not leak across tests either.
  state.currentWallet = null;
  state.pendingWallet = null;
  state.walletBuildCount = 0;
  state.invalidateSessionWalletMock.mockClear();
  state.ensureFreshVtxosMock.mockClear();
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
    expect(config.wallet).toMatchObject({ fakeWallet: true });
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

describe('getSwaps / payInvoice — sharing the session Arkade wallet', () => {
  it('builds ArkadeSwaps with the session wallet from getSessionWallet()', async () => {
    state.createArkadeSwaps.mockResolvedValue(fakeSwapInstance());

    const wallet = await getSessionWallet();
    await getSwaps(seed);

    const config = state.createArkadeSwaps.mock.calls[0][0];
    expect(config.wallet).toBe(wallet);
  });

  it('funds the payment with the identical wallet object ArkadeSwaps was built with, after refreshing VTXOs', async () => {
    const instance = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValue(instance);

    await payInvoice(seed, { invoice: INVOICE_250K, maxTotalSats: 250_350 });

    // One build total: the swap runtime and the funding send shared it.
    expect(state.walletBuildCount).toBe(1);
    const config = state.createArkadeSwaps.mock.calls[0][0];
    const walletAfter = await getSessionWallet(); // memoized: same object payInvoice funded with
    expect(config.wallet).toBe(walletAfter);
    expect(state.ensureFreshVtxosMock).toHaveBeenCalledExactlyOnceWith(walletAfter);
  });

  it('concurrent Lightning and normal wallet access builds the Arkade wallet only once', async () => {
    state.createArkadeSwaps.mockResolvedValue(fakeSwapInstance());

    const [, walletA, walletB] = await Promise.all([
      getSwaps(seed), // Lightning path
      getSessionWallet(), // e.g. a regular send or balance read
      getSessionWallet(),
    ]);

    expect(state.walletBuildCount).toBe(1);
    expect(walletA).toBe(walletB);
  });

  it('disposing the Lightning runtime does not touch the Arkade wallet', async () => {
    state.createArkadeSwaps.mockResolvedValue(fakeSwapInstance());

    await getSwaps(seed);
    const walletBefore = await getSessionWallet();
    await disposeSwaps();
    const walletAfter = await getSessionWallet();

    expect(walletAfter).toBe(walletBefore);
    expect(state.invalidateSessionWalletMock).not.toHaveBeenCalled();
  });

  it('a wallet invalidation without a matching disposeSwaps() leaves ArkadeSwaps on the stale wallet — why lock/switchNetwork must always pair the two', async () => {
    const instance = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValue(instance);

    await getSwaps(seed);
    const staleWallet = state.createArkadeSwaps.mock.calls[0][0].wallet;

    // What a lock or network switch does to the wallet side, without the paired
    // disposeSwaps() this refactor's invariant requires.
    await invalidateSessionWallet();
    const freshWallet = await getSessionWallet();
    expect(freshWallet).not.toBe(staleWallet);

    // lightning.ts has no way to notice that on its own: the same ArkadeSwaps
    // instance comes back, still holding the now-disposed wallet.
    const s = await getSwaps(seed);
    expect(s).toBe(instance);
    expect(state.createArkadeSwaps).toHaveBeenCalledOnce();
  });

  it('a lock racing an in-flight build disposes the late ArkadeSwaps instance and does not leave a stale wallet cached', async () => {
    const first = fakeSwapInstance();
    const second = fakeSwapInstance();
    const gate = deferred<ReturnType<typeof fakeSwapInstance>>();
    state.createArkadeSwaps.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(second);

    const building = getSwaps(seed); // wallet build already resolved; ArkadeSwaps.create is gated

    // A real lock or network switch invalidates both runtimes together.
    await disposeSwaps();
    await invalidateSessionWallet();

    gate.resolve(first); // the build finishes AFTER both dropped
    await expect(building).rejects.toThrow('LOCKED');
    expect(first.dispose).toHaveBeenCalledOnce(); // self-destructed, not leaked

    const b = await getSwaps(seed);
    expect(b).toBe(second);
    // The wallet was invalidated too, so the rebuild gets a fresh one, not the
    // one the disposed-of first build used.
    expect(state.walletBuildCount).toBe(2);
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

  it('is true for a pending submarine swap (payment still in flight)', async () => {
    state.repoSwaps = [{ id: 'a', type: 'submarine', status: 'invoice.set' }];
    expect(await hasPendingSwaps('regtest')).toBe(true);
  });

  it('is true for a failed-but-unrefunded submarine swap (refund still owed)', async () => {
    state.repoSwaps = [{ id: 'a', type: 'submarine', status: 'invoice.failedToPay' }];
    expect(await hasPendingSwaps('regtest')).toBe(true);
  });

  it('is false once a failed submarine swap has been refunded', async () => {
    state.repoSwaps = [
      { id: 'a', type: 'submarine', status: 'invoice.failedToPay', refunded: true },
    ];
    expect(await hasPendingSwaps('regtest')).toBe(false);
  });

  it('is false for a successfully completed submarine swap', async () => {
    state.repoSwaps = [{ id: 'a', type: 'submarine', status: 'transaction.claimed' }];
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
    expect(instance.recoverAllSubmarineFunds).not.toHaveBeenCalled();
  });

  it('sweeps stranded submarine refunds (failure status already FINAL at startup — the manager never monitors those)', async () => {
    const stranded = { id: 'sub-x', type: 'submarine', status: 'invoice.failedToPay' };
    state.repoSwaps = [
      stranded,
      // Already refunded → nothing owed.
      { id: 'sub-y', type: 'submarine', status: 'swap.expired', refunded: true },
      // Non-final refundable → the manager's own resumeActionableSwaps handles it.
      { id: 'sub-z', type: 'submarine', status: 'transaction.lockupFailed' },
      // Reverse swaps are never part of the refund sweep.
      { id: 'rev-1', type: 'reverse', status: 'swap.created' },
    ];
    const instance = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValue(instance);

    await reconcilePendingSwaps(seed);

    expect(instance.recoverAllSubmarineFunds).toHaveBeenCalledExactlyOnceWith([stranded]);
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

describe('submarineFeeForAmount', () => {
  it('is the flat miner fee when the percentage is zero', () => {
    expect(submarineFeeForAmount(250_000, { percentage: 0, minerFees: 100 })).toBe(100);
  });

  it('rounds the percentage part up and adds the miner fee', () => {
    // 0.1% of 250 000 = 250 exactly; 0.1% of 250 001 = 250.001 → 251.
    expect(submarineFeeForAmount(250_000, { percentage: 0.1, minerFees: 100 })).toBe(350);
    expect(submarineFeeForAmount(250_001, { percentage: 0.1, minerFees: 100 })).toBe(351);
  });
});

describe('mapSubmarineStatus — full status table', () => {
  const cases: Array<[BoltzSwapStatus, LnPayStatus]> = [
    ['swap.created', 'sending'],
    ['invoice.set', 'sending'],
    ['transaction.mempool', 'sending'],
    ['transaction.confirmed', 'sending'],
    ['invoice.pending', 'sending'],
    // The recipient has the money from invoice.paid on — Boltz sweeping its own
    // side afterwards (claim.pending/claimed) is not the user's concern.
    ['invoice.paid', 'paid'],
    ['transaction.claim.pending', 'paid'],
    ['transaction.claimed', 'paid'],
    // Failures → the always-on manager (or reconcile) refunds; UI shows the wait.
    ['invoice.failedToPay', 'refund-pending'],
    ['swap.expired', 'refund-pending'],
    ['transaction.lockupFailed', 'refund-pending'],
    ['transaction.refunded', 'refunded'],
    // Statuses that never apply to a submarine swap default to the non-terminal
    // 'sending' (never a misleading terminal state), mirroring mapReverseStatus.
    ['invoice.settled', 'sending'],
    ['invoice.expired', 'sending'],
    ['transaction.failed', 'sending'],
    ['transaction.server.mempool', 'sending'],
    ['transaction.server.confirmed', 'sending'],
  ];

  it.each(cases)('%s -> %s', (status, expected) => {
    expect(mapSubmarineStatus({ status })).toBe(expected);
  });

  it('the persisted refunded flag wins over any status — it is the only record the money came back', () => {
    expect(mapSubmarineStatus({ status: 'invoice.failedToPay', refunded: true })).toBe(
      'refunded',
    );
    expect(mapSubmarineStatus({ status: 'swap.expired', refunded: true })).toBe('refunded');
  });
});

describe('getPayQuote', () => {
  it('rejects on a network with no Boltz endpoint, without touching the network', async () => {
    state.network = 'testnet';
    await expect(getPayQuote({ invoice: INVOICE_250K })).rejects.toThrow(
      /not available on this network/i,
    );
    expect(state.providerConstructions).toHaveLength(0);
  });

  it('rejects a malformed invoice with a user-facing message', async () => {
    await expect(getPayQuote({ invoice: 'nonsense' })).rejects.toThrow(
      /valid Lightning invoice/i,
    );
  });

  it('rejects an amountless invoice — the invoice amount is what binds the swap', async () => {
    await expect(getPayQuote({ invoice: INVOICE_AMOUNTLESS })).rejects.toThrow(
      /no amount/i,
    );
  });

  it('rejects an invoice outside the Boltz limits', async () => {
    state.providerGetLimits.mockResolvedValue({ min: 300_000, max: 4_000_000 });
    await expect(getPayQuote({ invoice: INVOICE_250K })).rejects.toThrow(
      /between 300000 and 4000000/i,
    );
  });

  it('prices a valid invoice: submarine percentage + flat miner fee on top of the invoice amount', async () => {
    const quote = await getPayQuote({ invoice: INVOICE_250K });
    expect(quote).toEqual({
      amountSats: 250_000,
      feeSats: 350, // 0.1% of 250 000 (=250) + 100 miner
      totalSats: 250_350,
      description: '1 cup coffee',
    });
  });
});

describe('payInvoice', () => {
  it('rejects an amountless invoice before building anything', async () => {
    await expect(
      payInvoice(seed, { invoice: INVOICE_AMOUNTLESS, maxTotalSats: 1_000_000 }),
    ).rejects.toThrow(/no amount/i);
    expect(state.createArkadeSwaps).not.toHaveBeenCalled();
  });

  it('rejects an invoice outside the Boltz limits before creating a swap', async () => {
    const instance = fakeSwapInstance({
      getLimits: vi.fn(async () => ({ min: 300_000, max: 4_000_000 })),
    });
    state.createArkadeSwaps.mockResolvedValue(instance);

    await expect(
      payInvoice(seed, { invoice: INVOICE_250K, maxTotalSats: 1_000_000 }),
    ).rejects.toThrow(/between 300000 and 4000000/i);
    expect(instance.createSubmarineSwap).not.toHaveBeenCalled();
  });

  it('aborts BEFORE funding when Boltz asks for more than the confirmed total (+slack)', async () => {
    const instance = fakeSwapInstance({
      createSubmarineSwap: vi.fn(async () => ({
        id: 'sub-1',
        type: 'submarine',
        status: 'invoice.set',
        request: { invoice: INVOICE_250K, refundPublicKey: '03'.padEnd(66, 'b') },
        response: {
          address: 'tark1lockup',
          expectedAmount: 300_000,
          claimPublicKey: '02'.padEnd(66, 'c'),
          timeoutBlockHeights: {
            refund: 0,
            unilateralClaim: 0,
            unilateralRefund: 0,
            unilateralRefundWithoutReceiver: 0,
          },
        },
      })),
    });
    state.createArkadeSwaps.mockResolvedValue(instance);

    // Quoted total 250 350; slack for 250 000 sats is max(10, 250) = 250 →
    // anything above 250 600 must abort. 300 000 is a real inflation.
    await expect(
      payInvoice(seed, { invoice: INVOICE_250K, maxTotalSats: 250_350 }),
    ).rejects.toThrow(/more than the quoted total/i);
    expect(state.walletSend).not.toHaveBeenCalled();
  });

  it('aborts BEFORE funding when the reconstructed VHTLC address does not match', async () => {
    const instance = fakeSwapInstance({
      // Boltz returns a lockup address that does not match the VHTLC we reconstruct.
      createVHTLCScript: vi.fn(() => ({ vhtlcAddress: 'tark1DIFFERENT' })),
    });
    state.createArkadeSwaps.mockResolvedValue(instance);

    await expect(
      payInvoice(seed, { invoice: INVOICE_250K, maxTotalSats: 250_350 }),
    ).rejects.toThrow(/could not verify/i);
    expect(state.walletSend).not.toHaveBeenCalled();
  });

  it('funds the VHTLC at Boltz’s expectedAmount and returns the swap/tx identifiers', async () => {
    const instance = fakeSwapInstance();
    state.createArkadeSwaps.mockResolvedValue(instance);

    const result = await payInvoice(seed, { invoice: INVOICE_250K, maxTotalSats: 250_350 });

    expect(state.walletSend).toHaveBeenCalledExactlyOnceWith({
      address: 'tark1lockup',
      amount: 250_350,
    });
    // The reconstruction must get each pubkey in its correct VHTLC role. The mock ignores its
    // arguments, so without this a transposed receiver/sender/server key would still pass every
    // test while quietly bricking the pay path.
    expect(instance.createVHTLCScript).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverPubkey: '02'.padEnd(66, 'c'), // Boltz's claim key
        senderPubkey: '03'.padEnd(66, 'b'), // our refund key
        serverPubkey: '02'.padEnd(66, 'a'), // Arkade signer
      }),
    );
    expect(result).toEqual({
      swapId: 'sub-1',
      txid: 'ark-funding-txid',
      amountSats: 250_000,
      totalSats: 250_350,
    });
  });

  it('tolerates rounding drift within the slack', async () => {
    const instance = fakeSwapInstance({
      createSubmarineSwap: vi.fn(async () => ({
        id: 'sub-1',
        type: 'submarine',
        status: 'invoice.set',
        request: { invoice: INVOICE_250K, refundPublicKey: '03'.padEnd(66, 'b') },
        response: {
          address: 'tark1lockup',
          expectedAmount: 250_352,
          claimPublicKey: '02'.padEnd(66, 'c'),
          timeoutBlockHeights: {
            refund: 0,
            unilateralClaim: 0,
            unilateralRefund: 0,
            unilateralRefundWithoutReceiver: 0,
          },
        },
      })),
    });
    state.createArkadeSwaps.mockResolvedValue(instance);

    const result = await payInvoice(seed, { invoice: INVOICE_250K, maxTotalSats: 250_350 });
    expect(result.totalSats).toBe(250_352);
  });

  it('translates the SDK’s opaque insufficient-funds error into a clear message', async () => {
    state.createArkadeSwaps.mockResolvedValue(fakeSwapInstance());
    state.walletSend.mockRejectedValue(new Error('Insufficient funds'));

    await expect(
      payInvoice(seed, { invoice: INVOICE_250K, maxTotalSats: 250_350 }),
    ).rejects.toThrow(/not enough spendable balance/i);
  });
});

describe('payTotalSlack', () => {
  it('is 10 sats for small amounts, 0.1% (rounded up) for large ones', () => {
    expect(payTotalSlack(1_000)).toBe(10);
    expect(payTotalSlack(250_000)).toBe(250);
    expect(payTotalSlack(250_001)).toBe(251);
  });
});

describe('getPayStatus', () => {
  it('maps a found submarine swap through mapSubmarineStatus', async () => {
    state.repoSwaps = [{ id: 'sub-1', type: 'submarine', status: 'invoice.paid' }];
    expect(await getPayStatus('sub-1')).toBe('paid');
  });

  it('reads the refunded flag from the repository record', async () => {
    state.repoSwaps = [
      { id: 'sub-1', type: 'submarine', status: 'invoice.failedToPay', refunded: true },
    ];
    expect(await getPayStatus('sub-1')).toBe('refunded');
  });

  it('throws a clear, user-facing error when the swap is not found', async () => {
    state.repoSwaps = [{ id: 'sub-1', type: 'reverse', status: 'swap.created' }];
    await expect(getPayStatus('sub-1')).rejects.toThrow(/could not be found/i);
  });
});
