import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
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

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const browserMock = {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: structuredClone(local.get(key)) })),
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

import { handleApproveArkadeTransaction, handleSignArkadeCheckpoints } from './provider-handlers';
import { grantConnect, revokeGrant } from './permissions';
import { invalidateArkadeApprovals, ARKADE_APPROVAL_TTL_MS } from './arkade-approvals';
import { parsePsbt } from './psbt-inspect';
import { setVault } from './storage';
import { decodeProviderError } from './provider-api';
import {
  resolveApproval,
  rejectApprovalForOrigin,
  currentInFlight,
} from './approvals';

const HTTPS: MessageSenderLike = { origin: 'https://site.example' };

const oKey = SingleKey.fromHex('11'.repeat(32));
const buyerKey = SingleKey.fromHex('22'.repeat(32));
const sellerKey = SingleKey.fromHex('33'.repeat(32));
let O: Uint8Array;
let B: Uint8Array;
let S: Uint8Array;
let F: Uint8Array;

/**
 * A fake `Wallet` exposing exactly what the signing handlers touch: `identity` (real
 * SingleKey), `arkServerPublicKey` (operator x-only), the own offchain/boarding scripts,
 * and `arkProvider.getInfo()` for the dust floor.
 */
function fakeSigningWallet() {
  const ownScript = new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, B] }).script]);
  return {
    identity: buyerKey,
    arkServerPublicKey: O, // 32-byte x-only operator key
    offchainTapscript: ownScript,
    boardingTapscript: ownScript,
    arkProvider: { getInfo: async () => ({ dust: 330n, signerPubkey: hex.encode(O), forfeitPubkey: `02${hex.encode(F)}`, checkpointTapscript: hex.encode(checkpointPath().script) }) },
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
  F = await SingleKey.fromHex('44'.repeat(32)).xOnlyPublicKey();
  B = await buyerKey.xOnlyPublicKey();
  S = await sellerKey.xOnlyPublicKey();
});

beforeEach(async () => {
  // Clear any in-flight approval left by a prior test (module-level state in approvals.ts).
  if (currentInFlight()) await rejectApprovalForOrigin('https://site.example', 'reset');
  invalidateArkadeApprovals();
  local.clear();
  session.clear();
  unlocked = true;
  activeWallet = fakeSigningWallet();
  activeNetwork = 'regtest';
  activeEpoch = 1;
  getContext.mockClear();
  browserMock.windows.create.mockClear();
  await setVault({ v: 1 } as never);
  // The site is connected (read-only grant). Signing is NOT in the grant — it re-prompts.
  await grantConnect('https://site.example', ['tark1acct']);
});

afterEach(() => {
  invalidateArkadeApprovals();
  vi.restoreAllMocks();
});

function checkpointPath() {
  return CSVMultisigTapscript.encode({ pubkeys: [F], timelock: { value: 144n, type: 'blocks' } });
}

function release() {
  const leaf = MultisigTapscript.encode({ pubkeys: [O, B, S] }).script;
  const escrow = new VtxoScript([leaf]);
  const seller = new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, S] }).script]);
  const { arkTx, checkpoints } = buildOffchainTx(
    [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, tapLeafScript: escrow.findLeaf(hex.encode(leaf)), tapTree: escrow.encode() }],
    [{ script: seller.pkScript, amount: 99_000n }],
    checkpointPath(),
  );
  return { arkadePsbt: base64.encode(arkTx.toPSBT()), checkpoints: checkpoints.map((tx) => ({ psbt: base64.encode(tx.toPSBT()), inputIndexes: [0] })) };
}

async function operatorSigned(params: ReturnType<typeof release>) {
  return Promise.all(params.checkpoints.map(async ({ psbt }) => base64.encode((await oKey.sign(parsePsbt(psbt), [0])).toPSBT())));
}

function signers(psbt: string) {
  const tx = parsePsbt(psbt);
  expect(tx.isFinal).toBe(false);
  return (tx.getInput(0).tapScriptSig ?? []).map(([key]) => hex.encode(key.pubKey)).sort();
}

async function staged() {
  const params = release();
  const approval = await approving(() => handleApproveArkadeTransaction(HTTPS, params, getContext));
  if (approval.status !== 'awaiting-checkpoints') throw new Error('Expected staged approval');
  return { approval, checkpoints: await operatorSigned(params), params };
}

describe('linked Arkade signing handlers', () => {
  it('signs both transactions with one approval and preserves existing signatures', async () => {
    const params = release();
    params.checkpoints[0].psbt = (await operatorSigned(params))[0];
    const result = await approving(() => handleApproveArkadeTransaction(HTTPS, { ...params, signCheckpoints: true }, getContext));
    expect(result.status).toBe('signed');
    if (result.status !== 'signed') throw new Error('Expected immediate signatures');
    expect(signers(result.arkadePsbt)).toEqual([hex.encode(B)]);
    expect(signers(result.checkpoints[0])).toEqual([hex.encode(O), hex.encode(B)].sort());
    expect(browserMock.windows.create).toHaveBeenCalledOnce();
  });

  it('completes staged signing without another prompt and retries without signing again', async () => {
    const { approval, checkpoints } = await staged();
    expect(signers(approval.arkadePsbt)).toEqual([hex.encode(B)]);
    const sign = vi.spyOn(buyerKey, 'sign');
    const params = { approvalId: approval.approvalId, checkpoints };
    const result = await handleSignArkadeCheckpoints(HTTPS, params, getContext);
    expect(signers(result.checkpoints[0])).toEqual([hex.encode(O), hex.encode(B)].sort());
    expect(await handleSignArkadeCheckpoints(HTTPS, params, getContext)).toEqual(result);
    expect(sign).toHaveBeenCalledOnce();
    expect(browserMock.windows.create).toHaveBeenCalledOnce();
    const changed = base64.encode((await sellerKey.sign(parsePsbt(checkpoints[0]), [0])).toPSBT());
    await expect(handleSignArkadeCheckpoints(HTTPS, { ...params, checkpoints: [changed] }, getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
  });

  it('allows a corrected completion after missing operator signatures', async () => {
    const { approval, params, checkpoints } = await staged();
    await expect(handleSignArkadeCheckpoints(HTTPS, { approvalId: approval.approvalId, checkpoints: params.checkpoints.map((cp) => cp.psbt) }, getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
    await expect(handleSignArkadeCheckpoints(HTTPS, { approvalId: approval.approvalId, checkpoints }, getContext)).resolves.toHaveProperty('checkpoints');
  });

  it('rejects expiration and a background restart', async () => {
    const before = Date.now();
    const { approval, checkpoints } = await staged();
    expect(approval.expiresAt).toBeGreaterThanOrEqual(before + ARKADE_APPROVAL_TTL_MS);
    expect(approval.expiresAt).toBeLessThanOrEqual(Date.now() + ARKADE_APPROVAL_TTL_MS);
    const now = vi.spyOn(Date, 'now').mockReturnValue(approval.expiresAt);
    await expect(handleSignArkadeCheckpoints(HTTPS, { approvalId: approval.approvalId, checkpoints }, getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
    now.mockRestore();
    const next = await staged();
    invalidateArkadeApprovals();
    await expect(handleSignArkadeCheckpoints(HTTPS, { approvalId: next.approval.approvalId, checkpoints: next.checkpoints }, getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
  });

  it('binds approval to its origin and connection issuance', async () => {
    const { approval, checkpoints } = await staged();
    const params = { approvalId: approval.approvalId, checkpoints };
    await grantConnect('https://other.example', ['tark1acct']);
    await expect(handleSignArkadeCheckpoints({ origin: 'https://other.example' }, params, getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
    await revokeGrant('https://site.example');
    await grantConnect('https://site.example', ['tark1acct']);
    await expect(handleSignArkadeCheckpoints(HTTPS, params, getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
  });

  it.each(['revoke', 'replace'] as const)('rejects a new approval while a grant %s storage write is pending', async (change) => {
    let releaseWrite!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    browserMock.storage.local.set.mockImplementationOnce(async (items) => {
      signalStarted();
      await gate;
      for (const [key, value] of Object.entries(items)) local.set(key, value);
    });
    const mutation = change === 'revoke'
      ? revokeGrant('https://site.example')
      : grantConnect('https://site.example', ['tark1replacement']);
    await started;
    let finished = false;
    try {
      const request = handleApproveArkadeTransaction(HTTPS, release(), getContext);
      // If the stale persisted grant opens a prompt, reject it so the test fails
      // promptly rather than leaving the signing handler waiting for a decision.
      const outcome = await Promise.race([
        request.then(() => null, (error: unknown) => codeOf(error)),
        (async () => {
          while (!finished) {
            const pending = session.get('pendingApproval') as { requestId: string } | undefined;
            if (pending) {
              await resolveApproval(pending.requestId, { approved: false });
              return 'UNEXPECTED_PROMPT';
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return 'FINISHED';
        })(),
      ]);
      expect(outcome).toBe('NOT_CONNECTED');
      expect(browserMock.windows.create).not.toHaveBeenCalled();
    } finally {
      finished = true;
      releaseWrite();
      await mutation;
    }
  });

  it('rejects a replaced wallet session before signing', async () => {
    const { approval, checkpoints } = await staged();
    const sign = vi.spyOn(buyerKey, 'sign');
    activeEpoch++;
    await expect(handleSignArkadeCheckpoints(HTTPS, { approvalId: approval.approvalId, checkpoints }, getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'LOCKED');
    expect(sign).not.toHaveBeenCalled();
  });

  it.each(['lock', 'network', 'disconnect'] as const)('does not release checkpoint signatures after %s during signing', async (change) => {
    const { approval, checkpoints } = await staged();
    const originalSign = buyerKey.sign.bind(buyerKey);
    let releaseSign!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSign = resolve; });
    vi.spyOn(buyerKey, 'sign').mockImplementation(async (...args) => {
      signalStarted();
      await gate;
      return originalSign(...args);
    });
    const params = { approvalId: approval.approvalId, checkpoints };
    const completion = handleSignArkadeCheckpoints(HTTPS, params, getContext);
    await started;
    await expect(handleSignArkadeCheckpoints(HTTPS, params, getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BUSY');
    if (change === 'lock') unlocked = false;
    if (change === 'network') activeNetwork = 'mutinynet';
    if (change === 'disconnect') await revokeGrant('https://site.example');
    releaseSign();
    await expect(completion).rejects.toSatisfy((e: unknown) => codeOf(e) === (change === 'disconnect' ? 'NOT_CONNECTED' : 'LOCKED'));
  });

  it('rejects a declined approval without signing', async () => {
    const sign = vi.spyOn(buyerKey, 'sign');
    const request = handleApproveArkadeTransaction(HTTPS, release(), getContext);
    const pending = await waitForPending();
    await resolveApproval(pending.requestId, { approved: false });
    await expect(request).rejects.toSatisfy((e: unknown) => codeOf(e) === 'REJECTED');
    expect(sign).not.toHaveBeenCalled();
  });

  it.each(['lock', 'network', 'disconnect'] as const)('does not release immediate signatures after %s during payment signing', async (change) => {
    const originalSign = buyerKey.sign.bind(buyerKey);
    const sign = vi.spyOn(buyerKey, 'sign').mockImplementation(async (...args) => {
      const signed = await originalSign(...args);
      if (change === 'lock') unlocked = false;
      if (change === 'network') activeNetwork = 'mutinynet';
      if (change === 'disconnect') await revokeGrant('https://site.example');
      return signed;
    });
    await expect(approving(() => handleApproveArkadeTransaction(HTTPS, { ...release(), signCheckpoints: true }, getContext)))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === (change === 'disconnect' ? 'NOT_CONNECTED' : 'LOCKED'));
    expect(sign).toHaveBeenCalledOnce();
  });

  it('requires a connected origin and unlocked wallet before prompting', async () => {
    await expect(handleApproveArkadeTransaction({ origin: 'https://unknown.example' }, release(), getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'NOT_CONNECTED');
    unlocked = false;
    await expect(handleApproveArkadeTransaction(HTTPS, release(), getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'LOCKED');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('rejects unavailable operator parameters before prompting', async () => {
    const wallet = activeWallet as unknown as { arkProvider: { getInfo: () => Promise<unknown> } };
    vi.spyOn(wallet.arkProvider, 'getInfo').mockRejectedValue(new Error('offline'));
    await expect(handleApproveArkadeTransaction(HTTPS, release(), getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'bad-key', '02' + '00'.repeat(32)])('rejects an invalid or mismatched forfeit key %s before prompting', async (forfeitPubkey) => {
    const wallet = activeWallet as unknown as { arkProvider: { getInfo: () => Promise<unknown> } };
    vi.spyOn(wallet.arkProvider, 'getInfo').mockResolvedValue({
      dust: 330n, signerPubkey: hex.encode(O), forfeitPubkey,
      checkpointTapscript: hex.encode(checkpointPath().script),
    });
    await expect(handleApproveArkadeTransaction(HTTPS, release(), getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('rejects invalid operator configuration before prompting', async () => {
    const wallet = activeWallet as unknown as { arkProvider: { getInfo: () => Promise<unknown> } };
    vi.spyOn(wallet.arkProvider, 'getInfo').mockResolvedValue({ dust: 330n, signerPubkey: hex.encode(S), forfeitPubkey: `02${hex.encode(F)}`, checkpointTapscript: hex.encode(checkpointPath().script) });
    await expect(handleApproveArkadeTransaction(HTTPS, release(), getContext))
      .rejects.toSatisfy((e: unknown) => codeOf(e) === 'BAD_REQUEST');
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });
});
