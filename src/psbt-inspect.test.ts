import { describe, it, expect, beforeAll } from 'vitest';
import {
  SingleKey,
  VtxoScript,
  MultisigTapscript,
  CSVMultisigTapscript,
  CLTVMultisigTapscript,
  buildOffchainTx,
  Transaction,
} from '@arkade-os/sdk';
import { hex, base64 } from '@scure/base';
import {
  parsePsbt,
  inspectPsbt,
  PsbtRejectedError,
  ownScriptsFrom,
  type InspectContext,
} from './psbt-inspect';

/**
 * PSBT inspector (M4 core, BUILD_PLAN Phase 3 Track E; PLAN.md §7) + the contract
 * co-sign acceptance test (the coordinator-critical path, p2p-coordinator-mvp-spec §5).
 *
 * These exercise the REAL SDK primitives (`SingleKey`, `VtxoScript`,
 * `MultisigTapscript`, `buildOffchainTx`, `Transaction`) — no mocks of the crypto. We
 * build representative escrow / own-coin PSBTs and assert the inspector produces the
 * right human diff and the right own-vs-contract classification, and that the reject
 * paths fire for undecodable / out-of-range / non-ours / high-fee.
 */

// ─── fixtures: three real keys (operator O, user, other) ────────────────────────

const oKey = SingleKey.fromHex('11'.repeat(32));
const userKey = SingleKey.fromHex('22'.repeat(32));
const otherKey = SingleKey.fromHex('33'.repeat(32));

let O: Uint8Array;
let U: Uint8Array;
let X: Uint8Array;
let ctx: InspectContext;

/** A bcrt regtest context naming our user key, the operator, and our own dest scripts. */
function makeContext(ownScripts: Uint8Array[]): InspectContext {
  return {
    network: 'regtest',
    ownXOnly: hex.encode(U),
    operatorXOnly: hex.encode(O),
    ownScriptsHex: ownScriptsFrom(ownScripts),
    dustSats: 330,
    feeSanityBoundSats: 50_000,
  };
}

beforeAll(async () => {
  O = await oKey.xOnlyPublicKey();
  U = await userKey.xOnlyPublicKey();
  X = await otherKey.xOnlyPublicKey();
  ctx = makeContext([]);
});

// ─── escrow PSBT builders ───────────────────────────────────────────────────────

/** The checkpoint leaf `buildOffchainTx` needs (operator-only CSV, like the real one). */
function checkpointLeaf() {
  return CSVMultisigTapscript.encode({ pubkeys: [O], timelock: { value: 144n, type: 'blocks' } });
}

/**
 * Build a spend of a custom VtxoScript via its first leaf and return the arkTx PSBT
 * (base64), the parsed tx, and the escrow object. `outputs` default to a single dest.
 */
function buildSpend(
  leafScripts: Uint8Array[],
  outputs?: { script: Uint8Array; amount: bigint }[],
  inputValue = 100_000,
): { psbtB64: string; tx: Transaction; escrow: VtxoScript } {
  const escrow = new VtxoScript(leafScripts);
  const leaf = escrow.findLeaf(hex.encode(leafScripts[0]));
  const input = {
    txid: 'a'.repeat(64),
    vout: 0,
    value: inputValue,
    tapLeafScript: leaf,
    tapTree: escrow.encode(),
  };
  const outs =
    outputs ??
    [{ script: new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, X] }).script]).pkScript, amount: 99_000n }];
  const { arkTx } = buildOffchainTx([input], outs, checkpointLeaf());
  return { psbtB64: base64.encode(arkTx.toPSBT()), tx: arkTx, escrow };
}

// ─── ACCEPTANCE TEST: contract co-sign (the §5 L1 escrow path) ──────────────────

describe('contract co-sign — escrow L1 Multisig(O, user, other) [ACCEPTANCE]', () => {
  it('does NOT reject the escrow leaf as non-standard, and renders the co-sign view', () => {
    // L1 = Multisig(O, U, X) — the cooperative-release leaf; the user is 1 of 3 named.
    const l1 = MultisigTapscript.encode({ pubkeys: [O, U, X] }).script;
    const l5 = CSVMultisigTapscript.encode({
      pubkeys: [U, X],
      timelock: { value: 144n, type: 'blocks' },
    }).script;
    const { tx } = buildSpend([l1, l5]);

    // (a) it is NOT rejected, and (b) it surfaces the correct approval data.
    const summary = inspectPsbt(tx, [0], ctx);

    expect(summary.isContractCoSign).toBe(true);
    expect(summary.isPureContractCoSign).toBe(true);
    expect(summary.signInputs).toHaveLength(1);

    const si = summary.signInputs[0];
    expect(si.role).toBe('contract');
    expect(si.contract?.clause).toBe('cooperative'); // L1 release clause
    expect(si.contract?.required).toBe(3); // 1 of 3
    expect(si.contract?.signers).toEqual([hex.encode(O), hex.encode(U), hex.encode(X)]);
    // the destination + amount are visible in the decoded outputs
    expect(summary.outputs.some((o) => o.address?.startsWith('bcrt1') && o.amount === 99_000)).toBe(
      true,
    );
  });

  it('adds ONLY the user partial tapScriptSig and returns the PSBT UNFINALIZED', async () => {
    const l1 = MultisigTapscript.encode({ pubkeys: [O, U, X] }).script;
    const { tx } = buildSpend([l1]);

    expect(tx.getInput(0).tapScriptSig?.length ?? 0).toBe(0);

    // (c) only our sig is added; (d) the result is unfinalized.
    const signed = await userKey.sign(tx, [0]);
    expect(signed.getInput(0).tapScriptSig?.length ?? 0).toBe(1);
    expect(signed.isFinal).toBe(false);

    // the signing pubkey is ours, not a counterparty's
    const sigEntry = signed.getInput(0).tapScriptSig![0];
    expect(hex.encode(sigEntry[0].pubKey)).toBe(hex.encode(U));
  });

  it('classifies the dispute leaf L2 Multisig(O, C, B) the same way when we are B', async () => {
    // user plays the Buyer here; coordinator C is a third party.
    const cKey = SingleKey.fromHex('44'.repeat(32));
    const C = await cKey.xOnlyPublicKey();
    const l2 = MultisigTapscript.encode({ pubkeys: [O, C, U] }).script; // O,C,B with B=user
    const { tx } = buildSpend([l2]);

    const summary = inspectPsbt(tx, [0], ctx);
    expect(summary.signInputs[0].role).toBe('contract');
    expect(summary.signInputs[0].contract?.required).toBe(3);
    expect(summary.signInputs[0].contract?.signers).toContain(hex.encode(U));
  });

  it('flags a CSV unilateral-exit leaf (L5 CSVMultisig(S, B)) as UNILATERAL_EXIT', () => {
    const l5 = CSVMultisigTapscript.encode({
      pubkeys: [U, X],
      timelock: { value: 144n, type: 'blocks' },
    }).script;
    const { tx } = buildSpend([l5]);

    const summary = inspectPsbt(tx, [0], ctx);
    expect(summary.signInputs[0].role).toBe('contract');
    expect(summary.signInputs[0].contract?.clause).toBe('unilateral-exit');
    expect(summary.signInputs[0].contract?.timelock).toEqual({ kind: 'csv', value: '144' });
    expect(summary.flags).toContain('UNILATERAL_EXIT');
  });

  it('renders a CLTV timeout-refund leaf (L4) with its absolute timelock', () => {
    const l4 = CLTVMultisigTapscript.encode({
      pubkeys: [O, U, X],
      absoluteTimelock: 800_000n,
    }).script;
    const { tx } = buildSpend([l4]);

    const summary = inspectPsbt(tx, [0], ctx);
    expect(summary.signInputs[0].contract?.clause).toBe('timeout-refund');
    expect(summary.signInputs[0].contract?.timelock).toEqual({ kind: 'cltv', value: '800000' });
  });
});

// ─── own-coin spend + own-change detection ──────────────────────────────────────

describe('own-coin spend + own-change re-derivation', () => {
  it('classifies an input naming only us + the operator as an OWN coin', () => {
    // The wallet's own VTXO collaborative leaf names just (O, user) — no counterparty.
    const ownLeaf = MultisigTapscript.encode({ pubkeys: [O, U] }).script;
    const { tx } = buildSpend([ownLeaf]);

    const summary = inspectPsbt(tx, [0], ctx);
    expect(summary.signInputs[0].role).toBe('own');
    expect(summary.isContractCoSign).toBe(false);
  });

  it('detects an output paying back to our own script as change (not external)', () => {
    const ownLeaf = MultisigTapscript.encode({ pubkeys: [O, U] }).script;
    // change output goes to OUR own (O,U) script; the payment goes to (O,X)
    const changeScript = new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, U] }).script]).pkScript;
    const payScript = new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, X] }).script]).pkScript;
    const { tx } = buildSpend(
      [ownLeaf],
      [
        { script: payScript, amount: 60_000n },
        { script: changeScript, amount: 39_000n },
      ],
    );

    // context now knows the change script as ours
    const ctxWithChange = makeContext([changeScript]);
    const summary = inspectPsbt(tx, [0], ctxWithChange);

    const change = summary.outputs.find((o) => o.amount === 39_000);
    const pay = summary.outputs.find((o) => o.amount === 60_000);
    expect(change?.isOwnChange).toBe(true);
    expect(pay?.isOwnChange).toBe(false);
    // total leaving = signed input (100k) − own change (39k) = 61k; external = 60k payment
    expect(summary.totalToExternal).toBe(60_000);
    expect(summary.totalLeaving).toBe(61_000);
  });
});

// ─── reject paths ───────────────────────────────────────────────────────────────

describe('reject paths', () => {
  it('rejects an undecodable PSBT (parsePsbt → UNDECODABLE)', () => {
    expect(() => parsePsbt('not a psbt at all')).toThrow(PsbtRejectedError);
    try {
      parsePsbt('zzzz');
    } catch (e) {
      expect((e as PsbtRejectedError).code).toBe('UNDECODABLE');
    }
  });

  it('rejects empty inputIndexes (NO_INPUTS)', () => {
    const { tx } = buildSpend([MultisigTapscript.encode({ pubkeys: [O, U] }).script]);
    expect(() => inspectPsbt(tx, [], ctx)).toThrow(/No inputs/);
  });

  it('rejects an out-of-range input index (BAD_INPUT_INDEX)', () => {
    const { tx } = buildSpend([MultisigTapscript.encode({ pubkeys: [O, U] }).script]);
    try {
      inspectPsbt(tx, [5], ctx);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PsbtRejectedError).code).toBe('BAD_INPUT_INDEX');
    }
  });

  it('rejects an input that does NOT name us (NOT_OUR_INPUT)', () => {
    // a leaf of (O, X) only — the wallet is not a signer
    const foreign = MultisigTapscript.encode({ pubkeys: [O, X] }).script;
    const { tx } = buildSpend([foreign]);
    try {
      inspectPsbt(tx, [0], ctx);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PsbtRejectedError).code).toBe('NOT_OUR_INPUT');
    }
  });

  it('rejects an input whose taproot tree does not build the spent output (forged coin)', () => {
    // The core leaf-commitment attack: the input claims a leaf naming us (O,U) — which
    // WOULD read as our own coin — but its witnessUtxo (the coin actually being spent) is a
    // DIFFERENT taproot output. Because the committed tree no longer tweaks to the spent
    // output key, the leaf is not trustworthy and the input must be rejected (not signed,
    // not shown as an own coin). Tamper the witnessUtxo script to simulate this.
    const ours = MultisigTapscript.encode({ pubkeys: [O, U] }).script;
    const { tx } = buildSpend([ours]);
    const wu = tx.getInput(0).witnessUtxo!;
    const wrongScript = new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, X] }).script])
      .pkScript;
    tx.updateInput(0, { witnessUtxo: { script: wrongScript, amount: wu.amount } }, true);

    try {
      inspectPsbt(tx, [0], ctx);
      throw new Error('should have thrown — uncommitted spend path must be rejected');
    } catch (e) {
      expect((e as PsbtRejectedError).code).toBe('NOT_OUR_INPUT');
      expect((e as Error).message).toMatch(/committed|taproot tree|spend path|coin/i);
    }
  });


  it('rejects a fee above the sanity bound unless overridden (FEE_TOO_HIGH)', () => {
    // own-coin spend with a 100k input but only a 1k output → ~99k fee, over the 50k bound.
    const ownLeaf = MultisigTapscript.encode({ pubkeys: [O, U] }).script;
    const tinyOut = new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, X] }).script]).pkScript;
    const { tx } = buildSpend([ownLeaf], [{ script: tinyOut, amount: 1_000n }], 100_000);

    try {
      inspectPsbt(tx, [0], ctx);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PsbtRejectedError).code).toBe('FEE_TOO_HIGH');
    }
    // …but the explicit override lets it through
    const summary = inspectPsbt(tx, [0], ctx, { allowHighFee: true });
    expect(summary.fee).toBeGreaterThan(50_000);
  });
});
