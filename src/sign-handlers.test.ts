import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  SingleKey,
  VtxoScript,
  MultisigTapscript,
  CSVMultisigTapscript,
  buildOffchainTx,
} from '@arkade-os/sdk';
import { hex, base64 } from '@scure/base';
import type { MessageSenderLike } from './origin';
import type { SessionContext } from './wallet-runtime';

/**
 * signMessage + signPsbt HANDLER gating. The end-to-end contract a
 * connected site gets:
 *   • signing requires a CONNECTED origin + unlocked wallet; an unconnected origin is
 *     NOT_CONNECTED, a locked wallet is LOCKED.
 *   • signMessage rejects a sighash-shaped message BEFORE prompting (BAD_REQUEST).
 *   • a declined approval surfaces REJECTED; the seed never crosses (only the result).
 *   • signPsbt validates SW-side, opens the approval with the inspector summary, and on
 *     approve returns the UNFINALIZED PSBT carrying ONLY our partial sig.
 * Exercises the real SDK crypto for the PSBT/co-sign path.
 */

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const browserMock = {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: local.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) local.set(k, v);
      }),
      remove: vi.fn(async (key: string) => void local.delete(key)),
    },
    session: {
      get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) session.set(k, v);
      }),
      remove: vi.fn(async (key: string) => void session.delete(key)),
    },
  },
  runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
  windows: {
    create: vi.fn(async () => ({ id: 200 })),
    onRemoved: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
  },
};
vi.stubGlobal('browser', browserMock);
if (!globalThis.crypto) vi.stubGlobal('crypto', webcrypto);

let unlocked = true;
vi.mock('./wallet-runtime', () => ({ isUnlocked: () => unlocked }));
vi.mock('./wallet', () => ({
  networkConfig: () => ({ arkServerUrl: 'http://localhost:7070', esploraUrl: '', isMainnet: false }),
}));

import { handleSignMessage, handleSignPsbt } from './provider-handlers';
import { grantConnect } from './permissions';
import { setVault, setNetwork } from './storage';
import { decodeProviderError } from './provider-api';
import {
  resolveApproval,
  rejectApprovalForOrigin,
  rejectPendingApproval,
  currentInFlight,
} from './approvals';

const HTTPS: MessageSenderLike = { origin: 'https://site.example' };

const oKey = SingleKey.fromHex('11'.repeat(32));
const userKey = SingleKey.fromHex('22'.repeat(32));
const otherKey = SingleKey.fromHex('33'.repeat(32));
let O: Uint8Array;
let U: Uint8Array;
let X: Uint8Array;

/**
 * A fake `Wallet` exposing exactly what the signing handlers touch: `identity` (real
 * SingleKey), `arkServerPublicKey` (operator x-only), the own offchain/boarding scripts,
 * and `arkProvider.getInfo()` for the dust floor.
 */
function fakeSigningWallet() {
  const ownScript = new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, U] }).script]);
  return {
    identity: userKey,
    arkServerPublicKey: O, // 32-byte x-only operator key
    offchainTapscript: ownScript,
    boardingTapscript: ownScript,
    arkProvider: { getInfo: async () => ({ dust: 330n }) },
  } as never;
}

let activeWallet: ReturnType<typeof fakeSigningWallet>;
let activeNetwork: SessionContext['network'] = 'regtest';
let activeEpoch = 1;

function sessionContext(
  wallet = activeWallet,
  network = activeNetwork,
  epoch = activeEpoch,
): SessionContext {
  return {
    wallet,
    network,
    epoch,
    assertCurrent() {
      if (
        !unlocked ||
        activeWallet !== wallet ||
        activeNetwork !== network ||
        activeEpoch !== epoch
      ) {
        throw new Error('LOCKED');
      }
    },
  };
}

const getContext = vi.fn(async () => {
  if (!unlocked) throw new Error('LOCKED');
  return sessionContext();
});

function codeOf(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  return decodeProviderError(err.message)?.code ?? null;
}

/** Wait until the in-flight approval request has been persisted (the handler does async
 *  validation/wallet work before opening the window), then return it. */
async function waitForPending(): Promise<{ requestId: string; payload: unknown }> {
  for (let i = 0; i < 200; i++) {
    const pending = session.get('pendingApproval') as
      | { requestId: string; payload: unknown }
      | undefined;
    if (pending) return pending;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('no pending approval appeared');
}

/** Run a signing call to its approval, auto-approve, and return the result. */
async function approving<T>(call: () => Promise<T>): Promise<T> {
  const promise = call();
  const pending = await waitForPending();
  await resolveApproval(pending.requestId, { approved: true });
  return promise;
}

beforeAll(async () => {
  O = await oKey.xOnlyPublicKey();
  U = await userKey.xOnlyPublicKey();
  X = await otherKey.xOnlyPublicKey();
});

beforeEach(async () => {
  // Clear any in-flight approval left by a prior test (module-level state in approvals.ts).
  if (currentInFlight()) await rejectApprovalForOrigin('https://site.example', 'reset');
  local.clear();
  session.clear();
  unlocked = true;
  activeWallet = fakeSigningWallet();
  activeNetwork = 'regtest';
  activeEpoch = 1;
  getContext.mockClear();
  browserMock.windows.create.mockClear();
  await setVault({ v: 1 } as never);
  await setNetwork('regtest');
  // The site is connected (read-only grant). Signing is NOT in the grant — it re-prompts.
  await grantConnect('https://site.example', ['tark1acct']);
});

// ─── gating ─────────────────────────────────────────────────────────────────────

describe('signing gate', () => {
  it('rejects signMessage from an UNCONNECTED origin (NOT_CONNECTED), no prompt', async () => {
    await expect(
      handleSignMessage({ origin: 'https://nope.example' }, 'hi', getContext),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === 'NOT_CONNECTED');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('rejects signMessage when the wallet is LOCKED', async () => {
    unlocked = false;
    await expect(handleSignMessage(HTTPS, 'hi', getContext)).rejects.toSatisfy(
      (e: unknown) => codeOf(e) === 'LOCKED',
    );
  });
});

// ─── signMessage ──────────────────────────────────────────────────────────────

describe('handleSignMessage', () => {
  it('rejects a sighash-shaped message BEFORE prompting (BAD_REQUEST)', async () => {
    await expect(handleSignMessage(HTTPS, 'a'.repeat(64), getContext)).rejects.toSatisfy(
      (e: unknown) => codeOf(e) === 'BAD_REQUEST',
    );
    // never opened an approval window for the dangerous request
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('rejects a non-string message (BAD_REQUEST)', async () => {
    await expect(
      handleSignMessage(HTTPS, { not: 'a string' }, getContext),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
  });

  it('prompts, then returns a BIP322 signature on approve', async () => {
    const { signature } = await approving(() =>
      handleSignMessage(HTTPS, 'Sign in to Example', getContext),
    );
    expect(browserMock.windows.create).toHaveBeenCalledOnce();
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);
  });

  it('surfaces REJECTED when the user declines', async () => {
    const promise = handleSignMessage(HTTPS, 'hello', getContext);
    const pending = await waitForPending();
    await resolveApproval(pending.requestId, { approved: false });
    await expect(promise).rejects.toSatisfy((e: unknown) => codeOf(e) === 'REJECTED');
  });

  it('surfaces LOCKED and never signs when session lock cancels the approval', async () => {
    const sign = vi.spyOn(userKey, 'sign');
    const promise = handleSignMessage(HTTPS, 'hello', getContext);
    await waitForPending();

    await rejectPendingApproval('Wallet locked after inactivity.');

    await expect(promise).rejects.toSatisfy((e: unknown) => codeOf(e) === 'LOCKED');
    expect(sign).not.toHaveBeenCalled();
    sign.mockRestore();
  });

  it('rejects when the wallet session changes while resolving the approval', async () => {
    const sign = vi.spyOn(userKey, 'sign');
    const promise = handleSignMessage(HTTPS, 'hello', getContext);
    const pending = await waitForPending();

    activeWallet = fakeSigningWallet();
    activeEpoch++;
    await resolveApproval(pending.requestId, { approved: true });

    await expect(promise).rejects.toSatisfy((e: unknown) => codeOf(e) === 'LOCKED');
    expect(sign).not.toHaveBeenCalled();
    sign.mockRestore();
  });

  it('does not sign when the network changes during post-approval authorization', async () => {
    const sign = vi.spyOn(userKey, 'sign');
    const promise = handleSignMessage(HTTPS, 'hello', getContext);
    const pending = await waitForPending();

    activeNetwork = 'mutinynet';
    activeEpoch++;
    await resolveApproval(pending.requestId, { approved: true });

    await expect(promise).rejects.toSatisfy((e: unknown) => codeOf(e) === 'LOCKED');
    expect(sign).not.toHaveBeenCalled();
    sign.mockRestore();
  });
});

// ─── signPsbt (own-coin + contract co-sign) ─────────────────────────────────────

describe('handleSignPsbt', () => {
  /** Build an L1 escrow spend PSBT (base64) over Multisig(O, U, X). */
  function escrowPsbt(): string {
    const l1 = MultisigTapscript.encode({ pubkeys: [O, U, X] }).script;
    const escrow = new VtxoScript([l1]);
    const leaf = escrow.findLeaf(hex.encode(l1));
    const cp = CSVMultisigTapscript.encode({
      pubkeys: [O],
      timelock: { value: 144n, type: 'blocks' },
    });
    const dest = new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, X] }).script]).pkScript;
    const { arkTx } = buildOffchainTx(
      [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, tapLeafScript: leaf, tapTree: escrow.encode() }],
      [{ script: dest, amount: 99_000n }],
      cp,
    );
    return base64.encode(arkTx.toPSBT());
  }

  it('rejects an undecodable PSBT BEFORE prompting (BAD_REQUEST)', async () => {
    await expect(
      handleSignPsbt(HTTPS, { psbt: 'garbage', inputIndexes: [0] }, getContext),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('co-signs an escrow leaf: prompts, returns UNFINALIZED with only our sig', async () => {
    const { Transaction } = await import('@arkade-os/sdk');
    const psbt = escrowPsbt();

    const { psbt: out } = await approving(() =>
      handleSignPsbt(HTTPS, { psbt, inputIndexes: [0] }, getContext),
    );
    expect(browserMock.windows.create).toHaveBeenCalledOnce();

    const signed = Transaction.fromPSBT(base64.decode(out), {
      allowUnknown: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    const sigs = signed.getInput(0).tapScriptSig ?? [];
    expect(sigs.length).toBe(1); // only ours
    expect(hex.encode(sigs[0][0].pubKey)).toBe(hex.encode(U));
    expect(signed.isFinal).toBe(false); // UNFINALIZED
  });

  it('the approval window payload carries the contract co-sign summary (1 of 3)', async () => {
    const psbt = escrowPsbt();
    const promise = handleSignPsbt(HTTPS, { psbt, inputIndexes: [0] }, getContext);
    const pending = (await waitForPending()) as {
      requestId: string;
      payload: {
        kind: string;
        summary: { isContractCoSign: boolean; signInputs: { contract?: { required: number } }[] };
      };
    };
    expect(pending.payload.kind).toBe('signPsbt');
    expect(pending.payload.summary.isContractCoSign).toBe(true);
    expect(pending.payload.summary.signInputs[0].contract?.required).toBe(3);
    await resolveApproval(pending.requestId, { approved: false });
    await expect(promise).rejects.toSatisfy((e: unknown) => codeOf(e) === 'REJECTED');
  });

  it('does not sign when the wallet locks while approval is open', async () => {
    const sign = vi.spyOn(userKey, 'sign');
    const psbt = escrowPsbt();
    const promise = handleSignPsbt(HTTPS, { psbt, inputIndexes: [0] }, getContext);
    const pending = await waitForPending();

    unlocked = false;
    await resolveApproval(pending.requestId, { approved: true });

    await expect(promise).rejects.toSatisfy((e: unknown) => codeOf(e) === 'LOCKED');
    expect(sign).not.toHaveBeenCalled();
    sign.mockRestore();
  });

  it('does not sign after a lock and unlock on the same network', async () => {
    const sign = vi.spyOn(userKey, 'sign');
    const psbt = escrowPsbt();
    const promise = handleSignPsbt(HTTPS, { psbt, inputIndexes: [0] }, getContext);
    const pending = await waitForPending();

    unlocked = false;
    activeWallet = fakeSigningWallet();
    activeEpoch++;
    unlocked = true;
    await resolveApproval(pending.requestId, { approved: true });

    await expect(promise).rejects.toSatisfy((e: unknown) => codeOf(e) === 'LOCKED');
    expect(sign).not.toHaveBeenCalled();
    sign.mockRestore();
  });

  it('does not sign after the active network changes', async () => {
    const sign = vi.spyOn(userKey, 'sign');
    const psbt = escrowPsbt();
    const promise = handleSignPsbt(HTTPS, { psbt, inputIndexes: [0] }, getContext);
    const pending = await waitForPending();

    activeNetwork = 'mutinynet';
    activeEpoch++;
    await resolveApproval(pending.requestId, { approved: true });

    await expect(promise).rejects.toSatisfy((e: unknown) => codeOf(e) === 'LOCKED');
    expect(sign).not.toHaveBeenCalled();
    sign.mockRestore();
  });
});
