import { describe, it, expect, beforeAll } from 'vitest';
import {
  SingleKey,
  VtxoScript,
  MultisigTapscript,
  CSVMultisigTapscript,
  buildOffchainTx,
  BIP322,
} from '@arkade-os/sdk';
import { hex, base64 } from '@scure/base';
import {
  isSighashShaped,
  signMessageBIP322,
  signPsbtPartial,
  SignMessageError,
} from './signing';

/**
 * signMessage (BIP322 + sighash rejection) and signPsbt partial-sign (Track E2b, M4).
 * Exercises the REAL SDK crypto: `SingleKey` identities, `BIP322.sign`, and
 * `Identity.sign` on a real `buildOffchainTx` PSBT.
 */

const oKey = SingleKey.fromHex('11'.repeat(32));
const userKey = SingleKey.fromHex('22'.repeat(32));
const otherKey = SingleKey.fromHex('33'.repeat(32));

let O: Uint8Array;
let U: Uint8Array;
let X: Uint8Array;

beforeAll(async () => {
  O = await oKey.xOnlyPublicKey();
  U = await userKey.xOnlyPublicKey();
  X = await otherKey.xOnlyPublicKey();
});

// ─── sighash rejection ──────────────────────────────────────────────────────────

describe('isSighashShaped — blind-sign defence', () => {
  it('flags a bare 64-hex (32-byte) digest', () => {
    expect(isSighashShaped('a'.repeat(64))).toBe(true);
    expect(isSighashShaped('0x' + 'b'.repeat(64))).toBe(true);
    expect(isSighashShaped('  ' + 'C'.repeat(64) + '  ')).toBe(true); // trimmed + case
  });

  it('does NOT flag a real human message or other-length hex', () => {
    expect(isSighashShaped('Sign in to Example at 2026-06-26')).toBe(false);
    expect(isSighashShaped('hello world')).toBe(false);
    expect(isSighashShaped('deadbeef')).toBe(false); // 8 chars, not 64
    expect(isSighashShaped('a'.repeat(63))).toBe(false); // 63, not 64
    expect(isSighashShaped('a'.repeat(66))).toBe(false); // 66
  });
});

describe('signMessageBIP322', () => {
  it('rejects an empty message', async () => {
    await expect(signMessageBIP322(userKey, '   ')).rejects.toMatchObject({
      name: 'SignMessageError',
      code: 'EMPTY',
    });
  });

  it('rejects a sighash-shaped message (SIGHASH_SHAPED)', async () => {
    await expect(signMessageBIP322(userKey, 'a'.repeat(64))).rejects.toMatchObject({
      code: 'SIGHASH_SHAPED',
    });
    await expect(signMessageBIP322(userKey, 'a'.repeat(64))).rejects.toBeInstanceOf(
      SignMessageError,
    );
  });

  it('signs a real human message and the signature verifies', async () => {
    const msg = 'Sign in to Example — nonce 12345';
    const sig = await signMessageBIP322(userKey, msg);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
    // round-trip verify against the user key's P2TR address
    const addr = await taprootAddress(userKey);
    expect(BIP322.verify(msg, sig, addr)).toBe(true);
    // and a different message does NOT verify under the same signature
    expect(BIP322.verify('a different message', sig, addr)).toBe(false);
  });
});

// ─── partial-sign / unfinalized ──────────────────────────────────────────────────

describe('signPsbtPartial — adds only our sig, returns unfinalized', () => {
  it('adds exactly one tapScriptSig (ours) and keeps the PSBT unfinalized', async () => {
    const { Transaction } = await import('@arkade-os/sdk');
    const psbtB64 = buildEscrowSpendPsbt([O, U, X]);

    // wrap the user key as a minimal Wallet-like { identity }
    const fakeWallet = { identity: userKey } as unknown as Parameters<typeof signPsbtPartial>[0];
    const out = await signPsbtPartial(fakeWallet, psbtB64, [0]);

    const signed = Transaction.fromPSBT(base64.decode(out), {
      allowUnknown: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    const sigs = signed.getInput(0).tapScriptSig ?? [];
    expect(sigs.length).toBe(1); // only ours
    expect(hex.encode(sigs[0][0].pubKey)).toBe(hex.encode(U)); // and it IS ours
    expect(signed.isFinal).toBe(false); // UNFINALIZED — others co-sign next
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build an L1-style escrow spend PSBT (base64) spending via the first leaf. */
function buildEscrowSpendPsbt(pubkeys: Uint8Array[]): string {
  const l1 = MultisigTapscript.encode({ pubkeys }).script;
  const escrow = new VtxoScript([l1]);
  const leaf = escrow.findLeaf(hex.encode(l1));
  const checkpoint = CSVMultisigTapscript.encode({
    pubkeys: [pubkeys[0]],
    timelock: { value: 144n, type: 'blocks' },
  });
  const dest = new VtxoScript([MultisigTapscript.encode({ pubkeys: [pubkeys[0]] }).script])
    .pkScript;
  const { arkTx } = buildOffchainTx(
    [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, tapLeafScript: leaf, tapTree: escrow.encode() }],
    [{ script: dest, amount: 99_000n }],
    checkpoint,
  );
  return base64.encode(arkTx.toPSBT());
}

/**
 * The P2TR address for a SingleKey, for BIP322.verify round-trips. We sign with no
 * network override, so `BIP322.sign` uses btc-signer's default (mainnet `bc`) — verify
 * against the matching mainnet address.
 */
async function taprootAddress(key: SingleKey): Promise<string> {
  const { p2tr } = await import('@scure/btc-signer');
  const xonly = await key.xOnlyPublicKey();
  return p2tr(xonly).address!;
}
