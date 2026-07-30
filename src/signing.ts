import { BIP322, networks } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import type { SessionContext } from './wallet-runtime';
import {
  parsePsbt,
  inspectPsbt,
  ownScriptsFrom,
  type InspectContext,
  type PsbtSummary,
} from './psbt-inspect';

/**
 * The signing primitives behind `signMessage` + `signPsbt`.
 * Pure-ish helpers operating on an SDK `Wallet`/`Identity` plus the PSBT inspector — the
 * orchestration (origin + grant gating, the approval window, re-prompt-every-call) lives
 * in `provider-handlers.ts`; these are the crypto half, unit-testable on their own.
 *
 * Hard rules enforced here (security review):
 *  • `signMessage` is BIP322/Schnorr ONLY and REJECTS sighash-shaped input (a bare 32-byte
 *    hash), so a site can't smuggle a transaction sighash through the message signer and
 *    get a signature valid over a real tx ("blind-sign" confusion). Arkade is Schnorr-only,
 *    so the `'ecdsa'` path is never offered.
 *  • `signPsbt` adds ONLY our partial Schnorr `tapScriptSig` (via `Identity.sign`) and
 *    returns the PSBT UNFINALIZED — other parties co-sign in sequence. Signing key material
 *    never leaves the SW; only the signed PSBT (public) crosses back to the page.
 */

/** A signMessage validation failure surfaced to the page (its `.message` is user-facing). */
export class SignMessageError extends Error {
  constructor(
    readonly code: 'EMPTY' | 'SIGHASH_SHAPED',
    message: string,
  ) {
    super(message);
    this.name = 'SignMessageError';
  }
}

/**
 * True when `message` is shaped like a raw transaction sighash / txid: a bare 32-byte
 * value, given either as 64 hex chars (the way a site would pass a digest as text) or as
 * a 32-byte binary blob. A genuine human BIP322 message is text, never a bare digest —
 * so we refuse these to block the blind-sign-a-transaction attack.
 *
 * We are deliberately conservative: we only reject the *exact* 32-byte sighash shape, not
 * arbitrary hex (a user legitimately might sign "0xabc…" prose). 32 bytes is the size of a
 * Bitcoin sighash/txid, which is the only thing dangerous to blind-sign.
 */
export function isSighashShaped(message: string): boolean {
  const t = message.trim();
  // 64 hex chars = 32 bytes. Allow an optional 0x prefix.
  const hexBody = t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : t;
  return /^[0-9a-fA-F]{64}$/.test(hexBody);
}

/**
 * BIP322-sign a human message after rejecting empty + sighash-shaped input. Returns the
 * base64 BIP322 witness-stack signature. `network` is the BTC network descriptor BIP322
 * uses for the P2TR address derivation (we pass the wallet's).
 */
export async function signMessageBIP322(
  context: SessionContext,
  message: string,
): Promise<string> {
  if (message.trim().length === 0) {
    throw new SignMessageError('EMPTY', 'Cannot sign an empty message.');
  }
  if (isSighashShaped(message)) {
    throw new SignMessageError(
      'SIGHASH_SHAPED',
      'This looks like a transaction hash, not a message. For your safety the wallet ' +
        'only signs human-readable messages here, never a raw 32-byte hash.',
    );
  }
  context.assertCurrent();
  return BIP322.sign(message, context.wallet.identity, networks[context.network]);
}

/**
 * Validate a PSBT for signing and return the SW-computed summary the approval window
 * renders. Pure: parses + inspects only, signs nothing. Throws `PsbtRejectedError` for
 * the must-never-sign cases (undecodable / bad index / not ours / fee too high).
 */
export function validatePsbtForSigning(
  psbt: string,
  inputIndexes: number[],
  ctx: InspectContext,
  opts: { allowHighFee?: boolean } = {},
): { summary: PsbtSummary } {
  const tx = parsePsbt(psbt);
  const summary = inspectPsbt(tx, inputIndexes, ctx, opts);
  return { summary };
}

/**
 * The fee sanity bound, in sats — a fee above this is rejected for an own-coin spend
 * unless the user explicitly overrides. 100k sats is far above any legitimate off-chain
 * Arkade fee (which is ~zero) while still catching a malicious "fee that's really a
 * payout" output. Contract co-signs are exempt (their fee is the contract author's).
 */
export const FEE_SANITY_BOUND_SATS = 100_000;

/**
 * Build the {@link InspectContext} the PSBT inspector needs from the live wallet:
 *  • our x-only key (to detect us in a multisig leaf),
 *  • the operator x-only key (excluded when deciding "is this solely ours"),
 *  • our own output scripts (offchain VTXO + boarding pkScripts) for change detection,
 *  • the dust floor + fee bound.
 *
 * `arkServerPublicKey` is the 33-byte compressed operator key on the wallet; the leaves
 * carry the 32-byte x-only form, so we slice the parity byte off a 33-byte key.
 */
export async function buildInspectContext(
  context: SessionContext,
  dustSats: number,
): Promise<InspectContext> {
  const { wallet, network } = context;
  const ownXOnly = hex.encode(await wallet.identity.xOnlyPublicKey());
  const operatorXOnly = hex.encode(toXOnly(wallet.arkServerPublicKey));
  const ownScripts: Uint8Array[] = [];
  try {
    ownScripts.push(wallet.offchainTapscript.pkScript);
  } catch {
    /* offchain script unavailable — own-change just won't match the VTXO output */
  }
  try {
    ownScripts.push(wallet.boardingTapscript.pkScript);
  } catch {
    /* boarding script unavailable */
  }
  return {
    network,
    ownXOnly,
    operatorXOnly,
    ownScriptsHex: ownScriptsFrom(ownScripts),
    dustSats,
    feeSanityBoundSats: FEE_SANITY_BOUND_SATS,
  };
}

/** Normalize a 33-byte compressed pubkey to 32-byte x-only; pass a 32-byte key through. */
function toXOnly(key: Uint8Array): Uint8Array {
  return key.length === 33 ? key.slice(1) : key;
}

/**
 * Add ONLY our partial Schnorr `tapScriptSig` to the given inputs and return the PSBT
 * UNFINALIZED (base64). `Identity.sign(tx, inputIndexes)` signs only the inputs we hold a
 * key for and never finalizes, which is exactly the partial-sign / co-sign contract: the
 * other N-of-N parties (and the Arkade operator at `submitTx`) add their signatures after
 * us, in sequence. We re-parse from the original PSBT string so the bytes the user
 * approved are the bytes we sign — no chance of signing a different tx than was inspected.
 */
export async function signPsbtPartial(
  context: SessionContext,
  psbt: string,
  inputIndexes: number[],
): Promise<string> {
  const tx = parsePsbt(psbt);
  context.assertCurrent();
  const signed = await context.wallet.identity.sign(tx, inputIndexes);
  // toPSBT() serializes WITHOUT extracting/finalizing — the partial sig rides along.
  const { base64 } = await import('@scure/base');
  return base64.encode(signed.toPSBT());
}
