import { describe, it, expect } from 'vitest';
import { SingleKey, VtxoScript, MultisigTapscript, CSVMultisigTapscript, CLTVMultisigTapscript, ConditionMultisigTapscript, buildOffchainTx, Transaction } from '@arkade-os/sdk';
import { base64, hex } from '@scure/base';
import { inspectArkadeTransaction, prepareArkadeCheckpoints } from './arkade-inspect';
import { parsePsbt, type InspectContext } from './psbt-inspect';

async function fixture(mixed = false, own = false, path: 'plain' | 'cltv' | 'conditional' = 'plain', value = 100_000, sameCheckpointKey = false) {
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
  const { arkTx, checkpoints } = buildOffchainTx(inputs, [
    { script: destination.pkScript, amount: BigInt(inputs.length * value - 2_000) },
    { script: new VtxoScript([MultisigTapscript.encode({ pubkeys: [O] }).script]).pkScript, amount: 1_000n },
  ], checkpoint);
  const ctx: InspectContext = { network: 'regtest', ownXOnly: hex.encode(B), operatorXOnly: hex.encode(O), ownScriptsHex: new Set(), dustSats: 330, feeSanityBoundSats: 50_000 };
  const params = { arkadePsbt: base64.encode(arkTx.toPSBT()), checkpoints: checkpoints.map((cp, i) => ({ psbt: base64.encode(cp.toPSBT()), inputIndexes: i === 0 ? [0] : [] })) };
  return { params, ctx, checkpoint: hex.encode(checkpoint.script), forfeitXOnly: hex.encode(F), operator, buyer, seller, arkTx, checkpoints };
}

function edit(psbt: string, fn: (tx: Transaction) => void): string {
  const tx = parsePsbt(psbt);
  fn(tx);
  return base64.encode(tx.toPSBT());
}

describe('linked Arkade approval inspection', () => {
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
