import { describe, it, expect } from 'vitest';
import { ArkAddress, SingleKey, VtxoScript, MultisigTapscript, CSVMultisigTapscript, CLTVMultisigTapscript, ConditionMultisigTapscript, buildOffchainTx, Transaction } from '@arkade-os/sdk';
import { base64, hex } from '@scure/base';
import { inspectArkadeTransaction, prepareArkadeCheckpoints } from './arkade-inspect';
import { parsePsbt, type InspectContext } from './psbt-inspect';

async function fixture(mixed = false, own = false, path: 'plain' | 'cltv' | 'conditional' = 'plain', value = 100_000, sameCheckpointKey = false, native = false) {
  const operator = SingleKey.fromHex('11'.repeat(32));
  const buyer = SingleKey.fromHex('22'.repeat(32));
  const seller = SingleKey.fromHex('33'.repeat(32));
  const [O, B, S] = await Promise.all([operator.xOnlyPublicKey(), buyer.xOnlyPublicKey(), seller.xOnlyPublicKey()]);
  const F = sameCheckpointKey ? O : await SingleKey.fromHex('44'.repeat(32)).xOnlyPublicKey();
  const checkpoint = CSVMultisigTapscript.encode({ pubkeys: [F], timelock: { value: 1536n, type: 'seconds' } });
  const pubkeys = own ? [O, B] : [O, B, S];
  const release = path === 'cltv'
    ? CLTVMultisigTapscript.encode({ pubkeys, absoluteTimelock: 800_000n })
    : path === 'conditional'
      ? ConditionMultisigTapscript.encode({ pubkeys, conditionScript: new Uint8Array([0x51]) })
      : MultisigTapscript.encode({ pubkeys });
  const foreign = MultisigTapscript.encode({ pubkeys: [O, S] });
  const leaves = mixed ? [release, foreign] : [release];
  const inputs = leaves.map((leaf, i) => {
    const tree = new VtxoScript([leaf.script]);
    return { txid: (i ? 'bb' : 'aa').repeat(32), vout: 0, value, tapLeafScript: tree.findLeaf(hex.encode(leaf.script)), tapTree: tree.encode() };
  });
  const destination = new VtxoScript([foreign.script]);
  const treasury = new ArkAddress(O, new VtxoScript([MultisigTapscript.encode({ pubkeys: [O] }).script]).pkScript.slice(2));
  const change = new ArkAddress(O, destination.pkScript.slice(2));
  const buyerScript = new VtxoScript([MultisigTapscript.encode({ pubkeys: [O, B] }).script]).pkScript;
  const { arkTx, checkpoints } = buildOffchainTx(inputs, native ? [
    { script: buyerScript, amount: 1171n },
    { script: treasury.subdustPkScript, amount: 5n },
    { script: change.subdustPkScript, amount: 100n },
  ] : [
    { script: destination.pkScript, amount: BigInt(inputs.length * value - 2_000) },
    { script: new VtxoScript([MultisigTapscript.encode({ pubkeys: [O] }).script]).pkScript, amount: 1_000n },
  ], checkpoint);
  const ctx: InspectContext = { network: 'regtest', ownXOnly: hex.encode(B), operatorXOnly: hex.encode(O), ownScriptsHex: new Set(), dustSats: 330, feeSanityBoundSats: 50_000 };
  const params = { arkadePsbt: base64.encode(arkTx.toPSBT()), checkpoints: checkpoints.map((cp, i) => ({ psbt: base64.encode(cp.toPSBT()), inputIndexes: i === 0 ? [0] : [] })) };
  return { params, ctx, treasury, change, checkpoint: hex.encode(checkpoint.script), forfeitXOnly: hex.encode(F), operator, buyer, seller, arkTx, checkpoints };
}

function edit(psbt: string, fn: (tx: Transaction) => void): string {
  const tx = parsePsbt(psbt);
  fn(tx);
  return base64.encode(tx.toPSBT());
}

describe('linked Arkade approval inspection', () => {
  it('accepts the unsigned 1276-sat release with 1171/5/100 native payouts', async () => {
    const f = await fixture(false, false, 'plain', 1276, false, true);
    f.ctx.ownXOnly = hex.encode(await f.seller.xOnlyPublicKey());
    f.ctx.ownScriptsHex.add(hex.encode(f.change.pkScript));
    const result = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    expect(result.summary.payment.outputs).toEqual([
      expect.objectContaining({ index: 0, address: expect.stringMatching(/^bcrt1/), amount: 1171, isOwnChange: false }),
      { index: 1, address: null, amount: 5, kind: 'arkade-subdust', outputKey: hex.encode(f.treasury.vtxoTaprootKey), isOwnChange: false },
      { index: 2, address: null, amount: 100, kind: 'arkade-subdust', outputKey: hex.encode(f.change.vtxoTaprootKey), isOwnChange: true },
    ]);
    expect(result.summary.payment.totalToExternal).toBe(1176);
    expect(result.summary.payment.totalLeaving).toBe(1176);
    expect(result.summary.payment.fee).toBe(0);
    expect(result.summary.fee).toBe(0);
    expect(result.summary.payment.flags).toEqual([]);
    expect(result.arkadePsbt).toBe(f.params.arkadePsbt);
    expect(parsePsbt(result.arkadePsbt).getInput(0).tapScriptSig).toBeUndefined();
  });

  it.each([false, true])('accounts for native-only external payouts (own inputs: %s)', async (own) => {
    const f = await fixture(false, own, 'plain', 1276, false, true);
    f.params.arkadePsbt = edit(f.params.arkadePsbt, (tx) => {
      tx.updateOutput(0, { script: f.treasury.subdustPkScript, amount: 329n });
    });
    // Knowing the signer or even the native script is NOT proof of own change.
    f.ctx.ownScriptsHex.add(hex.encode(f.change.subdustPkScript));
    const { payment } = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly).summary;
    expect(payment.outputs.every((o) => o.kind === 'arkade-subdust' && !o.isOwnChange)).toBe(true);
    expect(payment.totalToExternal).toBe(434);
    expect(payment.totalLeaving).toBe(1276);
    expect(payment.fee).toBe(842);
    expect(payment.flags).toEqual(own ? ['SWEEP'] : []);
    f.ctx.feeSanityBoundSats = 841;
    expect(() => inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly)).toThrow(/fee/i);
  });

  it.each([1n, 329n])('accepts native amount %s within the dust boundaries', async (amount) => {
    const f = await fixture(false, false, 'plain', 1276, false, true);
    f.params.arkadePsbt = edit(f.params.arkadePsbt, (tx) => {
      tx.updateOutput(0, { amount: 800n });
      tx.updateOutput(1, { amount });
    });
    const { payment } = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly).summary;
    expect(payment.outputs[1].amount).toBe(Number(amount));
    expect(payment.totalToExternal).toBe(900 + Number(amount));
    expect(payment.fee).toBe(376 - Number(amount));
  });

  it('does not treat an output key equal to our signer key as own change', async () => {
    const f = await fixture(false, true, 'plain', 1276, false, true);
    f.params.arkadePsbt = edit(f.params.arkadePsbt, (tx) => {
      tx.updateOutput(2, { script: hex.decode(`6a20${f.ctx.ownXOnly}`) });
    });
    const { payment } = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly).summary;
    expect(payment.outputs[2].isOwnChange).toBe(false);
    expect(payment.totalToExternal).toBe(1276);
    expect(payment.flags).toEqual(['SWEEP']);
  });

  it.each([0n, 330n, 331n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])('rejects invalid native amount %s', async (amount) => {
    const f = await fixture(false, false, 'plain', 1276, false, true);
    f.params.arkadePsbt = edit(f.params.arkadePsbt, (tx) => tx.updateOutput(1, { amount }));
    expect(() => inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly)).toThrow('Invalid native Arkade sub-dust amount');
  });

  it.each([0, -1, 5, 100, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('fails closed for native payouts with dust threshold %s', async (dustSats) => {
    const f = await fixture(false, false, 'plain', 1276, false, true);
    f.ctx.dustSats = dustSats;
    expect(() => inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly)).toThrow('Invalid native Arkade sub-dust amount');
  });

  it.each(['data', 'short', 'long', 'pushdata', 'zero-key', 'out-of-field-key'] as const)('rejects native-looking %s scripts', async (variant) => {
    const f = await fixture(false, false, 'plain', 1276, false, true);
    const key = hex.encode(f.treasury.vtxoTaprootKey);
    const scripts = {
      data: '6a', short: `6a1f${key.slice(2)}`, long: `6a20${key}00`,
      pushdata: `6a4c20${key}`, 'zero-key': `6a20${'00'.repeat(32)}`,
      'out-of-field-key': `6a20${'ff'.repeat(32)}`,
    };
    f.params.arkadePsbt = edit(f.params.arkadePsbt, (tx) => tx.updateOutput(1, { script: hex.decode(scripts[variant]) }));
    expect(() => inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly)).toThrow();
  });

  it.each(['negative-fee', 'anchor-value', 'anchor-position', 'missing-anchor', 'checkpoint-value'] as const)('preserves linked validation for native payouts: %s', async (variant) => {
    const f = await fixture(false, false, 'plain', 1276, false, true);
    if (variant === 'checkpoint-value') {
      f.params.checkpoints[0].psbt = edit(f.params.checkpoints[0].psbt, (tx) => tx.updateOutput(0, { amount: 1275n }));
    } else {
      f.params.arkadePsbt = edit(f.params.arkadePsbt, (tx) => {
        if (variant === 'negative-fee') tx.updateOutput(0, { amount: 1172n });
        if (variant === 'anchor-value') tx.updateOutput(3, { amount: 1n });
        if (variant === 'anchor-position') tx.addOutput({ script: f.treasury.subdustPkScript, amount: 1n });
        if (variant === 'missing-anchor') tx.updateOutput(3, { script: f.treasury.subdustPkScript, amount: 1n });
      });
    }
    expect(() => inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly)).toThrow();
  });

  it('keeps supporting an operator that uses the same signer and forfeit key', async () => {
    const f = await fixture(false, false, 'plain', 100_000, true);
    expect(() => inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly)).not.toThrow();
  });

  it('rejects a checkpoint recovery key that differs from the advertised forfeit key', async () => {
    const f = await fixture();
    expect(f.forfeitXOnly).not.toBe(f.ctx.operatorXOnly);
    expect(() => inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.ctx.operatorXOnly))
      .toThrow('Invalid configured operator checkpoint path.');
  });

  it('validates a real escrow release and displays seller/platform payouts only', async () => {
    const f = await fixture();
    const result = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    expect(result.arkadeInputIndexes).toEqual([0]);
    expect(result.summary.fee).toBe(1000);
    expect(result.summary.payment.outputs.map((o) => o.amount)).toEqual([98000, 1000]);
    expect(result.summary.payment.flags).toEqual([]);
    expect(result.summary.originalInputs[0].contract?.required).toBe(3);
    const signed = await f.buyer.sign(parsePsbt(result.arkadePsbt), [0]);
    expect(signed.getInput(0).tapScriptSig).toHaveLength(1);
  });

  it('validates foreign checkpoints without requesting their signatures', async () => {
    const f = await fixture(true);
    const result = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    expect(result.summary.checkpointCount).toBe(2);
    expect(result.arkadeInputIndexes).toEqual([0]);
    const signed = await Promise.all(f.checkpoints.map((cp) => f.operator.sign(cp, [0])));
    expect(prepareArkadeCheckpoints(result, signed.reverse().map((cp) => base64.encode(cp.toPSBT())), f.ctx.operatorXOnly)).toHaveLength(2);
  });

  it('retains own-coin sweep warnings', async () => {
    const f = await fixture(false, true);
    const result = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    expect(result.summary.payment.isContractCoSign).toBe(false);
    expect(result.summary.payment.flags).toEqual(['SWEEP']);
  });

  it('accepts hex PSBTs and returns canonical base64', async () => {
    const f = await fixture();
    f.params.arkadePsbt = hex.encode(f.arkTx.toPSBT());
    const result = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    expect(result.arkadePsbt).toBe(base64.encode(f.arkTx.toPSBT()));
  });

  it.each(['selection', 'unselected', 'missing', 'duplicate', 'link', 'value', 'control', 'sighash', 'fee', 'csv', 'operator', 'data'] as const)('rejects invalid %s', async (variant) => {
    const f = await fixture();
    let csv = f.checkpoint;
    if (variant === 'selection') f.params.checkpoints[0].inputIndexes = [1];
    if (variant === 'unselected') f.params.checkpoints[0].inputIndexes = [];
    if (variant === 'missing') f.params.checkpoints = [];
    if (variant === 'duplicate') f.params.checkpoints.push(f.params.checkpoints[0]);
    if (variant === 'link') f.params.arkadePsbt = edit(f.params.arkadePsbt, (tx) => tx.updateInput(0, { txid: 'cc'.repeat(32) }));
    if (variant === 'value') f.params.checkpoints[0].psbt = edit(f.params.checkpoints[0].psbt, (tx) => tx.updateOutput(0, { amount: 90_000n }));
    if (variant === 'control') f.params.checkpoints[0].psbt = edit(f.params.checkpoints[0].psbt, (tx) => {
      const leaves = tx.getInput(0).tapLeafScript!;
      leaves[0][0].version ^= 1;
      // Rebuild to replace a keyed PSBT entry rather than append a second control block.
      tx.updateInput(0, { tapLeafScript: leaves });
    });
    if (variant === 'sighash') f.params.arkadePsbt = edit(f.params.arkadePsbt, (tx) => tx.updateInput(0, { sighashType: 0x81 }));
    if (variant === 'fee') f.ctx.feeSanityBoundSats = 999;
    if (variant === 'csv') csv = hex.encode(CSVMultisigTapscript.encode({ pubkeys: [await f.operator.xOnlyPublicKey()], timelock: { value: 145n, type: 'blocks' } }).script);
    if (variant === 'operator') f.ctx.operatorXOnly = f.forfeitXOnly;
    if (variant === 'data') f.params.arkadePsbt = edit(f.params.arkadePsbt, (tx) => tx.updateOutput(0, { script: new Uint8Array([0x6a]), amount: 0n }));
    expect(() => inspectArkadeTransaction(f.params, f.ctx, csv, f.forfeitXOnly)).toThrow();
  });

  it('preserves existing buyer signatures when adding verified operator signatures', async () => {
    const f = await fixture();
    const signedBuyer = await f.buyer.sign(f.checkpoints[0], [0]);
    f.params.checkpoints[0].psbt = base64.encode(signedBuyer.toPSBT());
    const approved = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    const both = await f.operator.sign(signedBuyer, [0]);
    const merged = prepareArkadeCheckpoints(approved, [base64.encode(both.toPSBT())], f.ctx.operatorXOnly);
    expect(parsePsbt(merged[0]).getInput(0).tapScriptSig).toHaveLength(2);
    expect(parsePsbt(merged[0]).getInput(0).finalScriptWitness).toBeUndefined();
  });

  it('rejects missing or invalid operator signatures and changed signing metadata', async () => {
    const f = await fixture();
    const approved = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    expect(() => prepareArkadeCheckpoints(approved, [f.params.checkpoints[0].psbt], f.ctx.operatorXOnly)).toThrow();
    const signed = await f.operator.sign(f.checkpoints[0], [0]);
    const metadataChanged = edit(base64.encode(signed.toPSBT()), (tx) => tx.updateInput(0, { sighashType: 1 }));
    expect(() => prepareArkadeCheckpoints(approved, [metadataChanged], f.ctx.operatorXOnly)).toThrow();
    const corrupted = signed.getInput(0).tapScriptSig!;
    corrupted[0][1][0] ^= 1;
    // Serialize the invalid signature through a fresh unsigned template.
    const bad = parsePsbt(f.params.checkpoints[0].psbt);
    bad.updateInput(0, { tapScriptSig: corrupted });
    expect(() => prepareArkadeCheckpoints(approved, [base64.encode(bad.toPSBT())], f.ctx.operatorXOnly)).toThrow();
  });

  it.each(['encoding', 'leaf', 'signer'] as const)('rejects a hostile operator signature %s', async (variant) => {
    const f = await fixture();
    const approved = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    const signed = await f.operator.sign(f.checkpoints[0], [0]);
    const signatures = signed.getInput(0).tapScriptSig!;
    if (variant === 'encoding') signatures[0][1] = new Uint8Array([...signatures[0][1], 0]);
    if (variant === 'leaf') signatures[0][0].leafHash[0] ^= 1;
    if (variant === 'signer') signatures[0][0].pubKey = await SingleKey.fromHex('44'.repeat(32)).xOnlyPublicKey();
    const bad = parsePsbt(f.params.checkpoints[0].psbt);
    bad.updateInput(0, { tapScriptSig: signatures });
    expect(() => prepareArkadeCheckpoints(approved, [base64.encode(bad.toPSBT())], f.ctx.operatorXOnly)).toThrow();
  });

  it('rejects unrelated checkpoint completion and duplicate submissions', async () => {
    const f = await fixture(true);
    const approved = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    const signed = await f.operator.sign(f.checkpoints[0], [0]);
    const psbt = base64.encode(signed.toPSBT());
    expect(() => prepareArkadeCheckpoints(approved, [psbt, psbt], f.ctx.operatorXOnly)).toThrow();
    const changed = edit(f.params.checkpoints[1].psbt, (tx) => tx.updateOutput(0, { amount: 99_999n }));
    expect(() => prepareArkadeCheckpoints(approved, [psbt, changed], f.ctx.operatorXOnly)).toThrow();
  });


  it.each(['cltv', 'conditional'] as const)('rejects unsupported %s spend paths', async (path) => {
    const f = await fixture(false, false, path);
    expect(() => inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly)).toThrow('Only plain cooperative');
  });

  it('rejects aggregate amounts outside the safe display range', async () => {
    const f = await fixture(true, false, 'plain', 2 ** 52);
    expect(() => inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly)).toThrow('Total input value');
  });

  it('rejects altered staged output metadata even when the transaction ID is unchanged', async () => {
    const f = await fixture();
    const approved = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    const signed = await f.operator.sign(f.checkpoints[0], [0]);
    const changed = edit(base64.encode(signed.toPSBT()), (tx) => tx.updateOutput(0, {
      tapInternalKey: hex.decode(f.ctx.operatorXOnly),
    }));
    expect(parsePsbt(changed).id).toBe(signed.id);
    expect(() => prepareArkadeCheckpoints(approved, [changed], f.ctx.operatorXOnly)).toThrow('output metadata changed');
  });

  it('rejects a wrong leaf hash on another participant signature alongside a valid operator signature', async () => {
    const f = await fixture();
    const approved = inspectArkadeTransaction(f.params, f.ctx, f.checkpoint, f.forfeitXOnly);
    const buyerSigned = await f.buyer.sign(f.checkpoints[0], [0]);
    const both = await f.operator.sign(buyerSigned, [0]);
    const signatures = both.getInput(0).tapScriptSig!;
    const buyerSignature = signatures.find(([key]) => hex.encode(key.pubKey) === f.ctx.ownXOnly)!;
    buyerSignature[0].leafHash[0] ^= 1;
    const bad = parsePsbt(f.params.checkpoints[0].psbt);
    bad.updateInput(0, { tapScriptSig: signatures });
    expect(() => prepareArkadeCheckpoints(approved, [base64.encode(bad.toPSBT())], f.ctx.operatorXOnly)).toThrow('Invalid or missing');
  });

});
