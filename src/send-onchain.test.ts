import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DustChangeError, type Wallet } from '@arkade-os/sdk';
import { SendValidationError } from './wallet';
import type { SessionContext } from './wallet-runtime';

/**
 * `sendOnchain` integration tests — verifies address validation, balance pre-check,
 * and that `Ramps.offboard` is called with the expected args. The pure validator
 * (`validateOnchainAddress`) is covered in send.test.ts.
 *
 * Module mocking strategy:
 *  • `./storage` → `getNetwork` returns 'regtest' (default dev network).
 *  • `@arkade-os/sdk` → `Ramps` is replaced with a spy so `offboard` is interceptable
 *    without a live operator. All other SDK exports (ArkAddress, networks, isExpired…)
 *    pass through via importOriginal.
 */

// vi.hoisted runs before module resolution, making offboardMock available to vi.mock.
const offboardMock = vi.hoisted(() => vi.fn(async () => 'offboard-txid'));
const onboardMock = vi.hoisted(() => vi.fn(async () => 'onboard-txid'));

vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>();
  return { ...actual, getNetwork: vi.fn().mockResolvedValue('regtest') };
});

vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>();
  return {
    ...actual,
    Ramps: class {
      constructor(_w: unknown) {}
      offboard = offboardMock;
      onboard = onboardMock;
    },
  };
});

// Import AFTER vi.mock so the mocked modules are in place.
import { onboardBoarding, sendOnchain } from './wallet';

const AVAILABLE = 100_000;

/** Minimal wallet mock — getBalance/getVtxos drive the expiry-adjusted balance;
 *  arkProvider.getInfo supplies the FeeInfo passed to Ramps.offboard. */
function mockWallet(available = AVAILABLE) {
  return {
    getBalance: vi.fn(async () => ({
      boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
      settled: available,
      preconfirmed: 0,
      available,
      recoverable: 0,
      pendingRecovery: 0,
      total: available,
      assets: [],
    })),
    getVtxos: vi.fn(async () => []), // no expired/recoverable → available unchanged
    arkProvider: { getInfo: vi.fn(async () => ({ fees: { someField: 1 } })) },
  } as unknown as Wallet;
}

function context(wallet: Wallet, assertCurrent: () => void = vi.fn()): SessionContext {
  return { wallet, network: 'regtest', epoch: 1, assertCurrent };
}

beforeEach(() => {
  offboardMock.mockResolvedValue('offboard-txid');
  offboardMock.mockClear();
  onboardMock.mockResolvedValue('onboard-txid');
  onboardMock.mockClear();
});

describe('sendOnchain — validation', () => {
  it('rejects an on-chain address for the wrong network', async () => {
    const wallet = mockWallet();
    // regtest expects bcrt1…; bc1… is mainnet → ADDRESS_WRONG_NETWORK
    await expect(
      sendOnchain(context(wallet), { address: 'bc1qtest', amount: 1000 }),
    ).rejects.toBeInstanceOf(SendValidationError);
  });

  it('rejects when explicit amount exceeds available balance', async () => {
    const wallet = mockWallet(50_000);
    await expect(
      sendOnchain(context(wallet), { address: 'bcrt1qtest', amount: 100_000 }),
    ).rejects.toBeInstanceOf(SendValidationError);
  });
});

describe('sendOnchain — Ramps.offboard call', () => {
  it('calls offboard with address, fees, and BigInt amount for explicit amount', async () => {
    const wallet = mockWallet();
    const result = await sendOnchain(context(wallet), {
      address: 'bcrt1qtest',
      amount: 50_000,
    });
    expect(offboardMock).toHaveBeenCalledOnce();
    expect(offboardMock).toHaveBeenCalledWith('bcrt1qtest', { someField: 1 }, BigInt(50_000));
    expect(result.txid).toBe('offboard-txid');
  });

  it('calls offboard without amount for send-all (Max)', async () => {
    const wallet = mockWallet();
    const result = await sendOnchain(context(wallet), { address: 'bcrt1qtest' });
    expect(offboardMock).toHaveBeenCalledOnce();
    expect(offboardMock).toHaveBeenCalledWith('bcrt1qtest', { someField: 1 }, undefined);
    expect(result.txid).toBe('offboard-txid');
  });

  it('skips balance check when amount is omitted (send-all path)', async () => {
    // Even with a tiny balance, send-all should not throw AMOUNT_EXCEEDS_BALANCE.
    const wallet = mockWallet(100);
    await expect(sendOnchain(context(wallet), { address: 'bcrt1qtest' })).resolves.toEqual({
      txid: 'offboard-txid',
    });
    expect(wallet.getBalance).not.toHaveBeenCalled();
  });
});

describe('sendOnchain — offboard error translation', () => {
  // Ramps.offboard deducts a per-input fee BEFORE the amount check, so its real failures
  // are fee-relative and never say "insufficient funds". Each must surface as a clear,
  // non-raw message on the funds-leaving popup.
  it('translates the empty/dust wallet send-all failure', async () => {
    offboardMock.mockRejectedValue(new Error('No vtxos available after deducting fees'));
    await expect(sendOnchain(context(mockWallet()), { address: 'bcrt1qtest' })).rejects.toThrow(
      /no spendable balance to withdraw/i,
    );
  });

  it('translates amount-exceeds-total-after-fees (the gross-balance band)', async () => {
    offboardMock.mockRejectedValue(
      new Error('Amount is greater than total amount of vtxos after fees'),
    );
    await expect(
      sendOnchain(context(mockWallet()), { address: 'bcrt1qtest', amount: 50_000 }),
    ).rejects.toThrow(/too little after the network fee/i);
  });

  it('translates DustChangeError to a use-Max message', async () => {
    offboardMock.mockRejectedValue(new DustChangeError(10n, 330n));
    await expect(
      sendOnchain(context(mockWallet()), { address: 'bcrt1qtest', amount: 50_000 }),
    ).rejects.toThrow(/leftover change would be too small/i);
  });
});

describe('sendOnchain — scheduled-session guard', () => {
  // An offboard's `settle` blocks until the next session; a far-out scheduled window would
  // outlive the MV3 service worker, so sendOnchain refuses up front rather than hang.
  function walletWithSession(nextStartTimeSec: number) {
    const w = mockWallet();
    w.arkProvider.getInfo = vi.fn(async () => ({
      fees: { someField: 1 },
      scheduledSession: {
        nextStartTime: BigInt(nextStartTimeSec),
        nextEndTime: 0n,
        period: 0n,
        duration: 0n,
        fees: {},
      },
    })) as never;
    return w;
  }

  it('refuses (with an ETA) when the next settlement window is far out', async () => {
    const wallet = walletWithSession(Math.floor(Date.now() / 1000) + 3600); // ~1h out
    await expect(sendOnchain(context(wallet), { address: 'bcrt1qtest' })).rejects.toThrow(
      /scheduled windows/i,
    );
    expect(offboardMock).not.toHaveBeenCalled();
  });

  it('proceeds when the session window is open/imminent', async () => {
    const wallet = walletWithSession(Math.floor(Date.now() / 1000)); // open now
    await expect(sendOnchain(context(wallet), { address: 'bcrt1qtest' })).resolves.toEqual({
      txid: 'offboard-txid',
    });
    expect(offboardMock).toHaveBeenCalledOnce();
  });

  it('does not start offboard after the session context becomes stale', async () => {
    const wallet = mockWallet();
    const assertCurrent = vi.fn(() => {
      throw new Error('LOCKED');
    });

    await expect(
      sendOnchain(context(wallet, assertCurrent), { address: 'bcrt1qtest' }),
    ).rejects.toThrow('LOCKED');
    expect(offboardMock).not.toHaveBeenCalled();
  });
});

describe('onboardBoarding — session authorization', () => {
  it('does not start onboarding after the operator read invalidates the context', async () => {
    let current = true;
    const wallet = mockWallet();
    wallet.getBalance = vi.fn(async () => ({
      boarding: { confirmed: 10_000, unconfirmed: 0, total: 10_000 },
    })) as never;
    wallet.arkProvider.getInfo = vi.fn(async () => {
      current = false;
      return { fees: { someField: 1 } };
    }) as never;
    const assertCurrent = () => {
      if (!current) throw new Error('LOCKED');
    };

    await expect(onboardBoarding(context(wallet, assertCurrent))).rejects.toThrow('LOCKED');
    expect(onboardMock).not.toHaveBeenCalled();
  });
});
