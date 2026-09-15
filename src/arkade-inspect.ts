import {
  Transaction,
  VtxoScript,
  VtxoTaprootTree,
  getArkPsbtFields,
  decodeTapscript,
  CSVMultisigTapscript,
  buildOffchainTx,
  P2A,
  verifyTapscriptSignatures,
} from '@arkade-os/sdk';
import { base64, hex } from '@scure/base';
import type { ApproveArkadeTransactionParams } from './provider-api';
import {
  inspectPsbt,
  parsePsbt,
  PsbtRejectedError,
  type InspectContext,
  type PsbtSummary,
  type SignInputSummary,
} from './psbt-inspect';

export interface ArkadeTransactionSummary {
  payment: PsbtSummary;
  checkpointCount: number;
  originalInputs: SignInputSummary[];
  fee: number;
}

export interface ValidatedArkadeTransaction {
  summary: ArkadeTransactionSummary;
  arkadePsbt: string;
  arkadeInputIndexes: number[];
  checkpoints: { psbt: string; inputIndexes: number[] }[];
}

function reject(message: string): never {
  throw new PsbtRejectedError('UNDECODABLE', message);
}

// Stable comparison includes byte arrays and bigint amounts, independent of object key order.
function stable(value: unknown): string {
  if (value instanceof Uint8Array) return hex.encode(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function equal(a: unknown, b: unknown, message: string): void {
  if (stable(a) !== stable(b)) reject(message);
}

function canonical(tx: Transaction): string {
  return base64.encode(tx.toPSBT());
}

function checkSignatures(tx: Transaction, index: number, required: string[] = []): void {
  if (!tx.getInput(index).tapScriptSig?.length && required.length === 0) return;
  const input = tx.getInput(index);
  const leaf = input.tapLeafScript?.[0]?.[1];
  if (!leaf) reject('Missing cooperative signature leaf.');
  const decoded = decodeTapscript(leaf.slice(0, -1));
  if (decoded.type !== 'multisig') reject('Unsupported signature leaf.');
  const signers = (decoded.params as { pubkeys: Uint8Array[] }).pubkeys.map((key) => hex.encode(key));
  for (const [key, sig] of input.tapScriptSig ?? []) {
    if (
      (sig.length !== 64 && sig.length !== 65) ||
      (sig.length === 65 && sig[64] !== 1) ||
      !signers.includes(hex.encode(key.pubKey))
    ) {
      reject('Invalid cooperative signature encoding or signer.');
    }
  }
  try {
    // All leaves were restricted to exactly one, so the SDK also checks its leaf hash.
    verifyTapscriptSignatures(tx, index, required, [], [0, 1]);
  } catch {
    reject('Invalid or missing cooperative signature.');
  }
}

function cooperativeInput(tx: Transaction, index: number, operator: string) {
  const input = tx.getInput(index);
  if (
    !input.txid ||
    input.index === undefined ||
    !input.witnessUtxo ||
    input.tapLeafScript?.length !== 1
  ) {
    reject('Each input requires an outpoint, witnessUtxo and exactly one cooperative leaf.');
  }
  if (
    input.finalScriptWitness?.length ||
    input.finalScriptSig?.length ||
    input.tapKeySig ||
    input.partialSig?.length
  ) {
    reject('Finalized and non-tapscript inputs are not supported.');
  }
  if (input.sighashType !== undefined && input.sighashType !== 0 && input.sighashType !== 1) {
    reject('Only default or SIGHASH_ALL signatures are supported.');
  }
  const amount = input.witnessUtxo.amount;
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) reject('Invalid input amount.');
  const [control, scriptWithVersion] = input.tapLeafScript[0];
  if (scriptWithVersion.at(-1) !== 0xc0) reject('Unsupported tapleaf version.');
  const script = scriptWithVersion.slice(0, -1);
  const decoded = decodeTapscript(script);
  if (decoded.type !== 'multisig') reject('Only plain cooperative multisig paths are supported.');
  const signers = (decoded.params as { pubkeys: Uint8Array[] }).pubkeys.map((key) => hex.encode(key));
  if (!signers.includes(operator) || new Set(signers).size !== signers.length) {
    reject('The cooperative path must include the configured operator without duplicate keys.');
  }
  const trees = getArkPsbtFields(tx, index, VtxoTaprootTree);
  if (trees.length !== 1) reject('Each input requires exactly one Arkade taproot tree.');
  const tree = VtxoScript.decode(trees[0]);
  equal(tree.pkScript, input.witnessUtxo.script, 'Input taproot tree does not match its prevout.');
  const proof = tree.findLeaf(hex.encode(script));
  equal(
    [control, scriptWithVersion],
    proof,
    'Input control block does not match the committed cooperative leaf.',
  );
  checkSignatures(tx, index);
  return { input, script, tree: trees[0], signers };
}

export function inspectArkadeTransaction(
  params: ApproveArkadeTransactionParams,
  ctx: InspectContext,
  checkpointTapscript: string,
  forfeitXOnly: string,
): ValidatedArkadeTransaction {
  try {
    return inspectLinked(params, ctx, checkpointTapscript, forfeitXOnly);
  } catch (error) {
    if (error instanceof PsbtRejectedError) throw error;
    reject('Malformed linked Arkade transaction or checkpoint metadata.');
  }
}

function inspectLinked(
  params: ApproveArkadeTransactionParams,
  ctx: InspectContext,
  checkpointTapscript: string,
  forfeitXOnly: string,
): ValidatedArkadeTransaction {
  if (
    !params ||
    !Array.isArray(params.checkpoints) ||
    params.checkpoints.length === 0 ||
    (params.signCheckpoints !== undefined && typeof params.signCheckpoints !== 'boolean')
  ) {
    reject('A complete checkpoint set is required.');
  }
  // The checkpoint recovery key may differ from the cooperative operator signer.
  const unroll = decodeTapscript(hex.decode(checkpointTapscript));
  if (
    !/^[0-9a-f]{64}$/.test(forfeitXOnly) ||
    !CSVMultisigTapscript.is(unroll) ||
    unroll.params.pubkeys.length !== 1 ||
    hex.encode(unroll.params.pubkeys[0]) !== forfeitXOnly
  ) {
    reject('Invalid configured operator checkpoint path.');
  }
  const payment = parsePsbt(params.arkadePsbt);
  if (payment.inputsLength !== params.checkpoints.length) {
    reject('The checkpoint set must cover every payment input.');
  }
  // Validate original spend proofs before deriving any checkpoint relationships.
  const checkpoints = params.checkpoints.map((item) => {
    if (
      !item ||
      !Array.isArray(item.inputIndexes) ||
      (item.inputIndexes.length !== 0 && (item.inputIndexes.length !== 1 || item.inputIndexes[0] !== 0))
    ) {
      reject('Checkpoint signing indexes must be [] or [0].');
    }
    const tx = parsePsbt(item.psbt);
    if (tx.inputsLength !== 1) reject('Each checkpoint must have one input.');
    return {
      tx,
      inputIndexes: [...item.inputIndexes],
      details: cooperativeInput(tx, 0, ctx.operatorXOnly),
    };
  });
  if (!checkpoints.some((cp) => cp.inputIndexes.length)) {
    reject('At least one checkpoint input must be selected.');
  }
  if (
    checkpoints.reduce((sum, cp) => sum + cp.details.input.witnessUtxo!.amount, 0n) >
    BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    reject('Total input value exceeds the supported range.');
  }
  const byId = new Map(checkpoints.map((cp) => [cp.tx.id, cp]));
  const outpoints = new Set(
    checkpoints.map((cp) => `${hex.encode(cp.details.input.txid!)}:${cp.details.input.index}`),
  );
  if (byId.size !== checkpoints.length || outpoints.size !== checkpoints.length) {
    reject('Duplicate checkpoints or original outpoints.');
  }
  // Rebuild each checkpoint, then bind its output to exactly one payment input.
  const seen = new Set<string>();
  const indexes: number[] = [];
  const originals: SignInputSummary[] = [];
  for (let i = 0; i < payment.inputsLength; i++) {
    const details = cooperativeInput(payment, i, ctx.operatorXOnly);
    const id = hex.encode(details.input.txid!);
    const cp = byId.get(id);
    if (!cp || seen.has(id) || details.input.index !== 0) {
      reject('Payment inputs must spend each checkpoint output exactly once.');
    }
    seen.add(id);
    const original = cp.details.input;
    const expected = buildOffchainTx(
      [{
        txid: hex.encode(original.txid!),
        vout: original.index!,
        value: Number(original.witnessUtxo!.amount),
        tapLeafScript: original.tapLeafScript![0],
        tapTree: cp.details.tree,
      }],
      [],
      unroll,
    );
    equal(
      cp.tx.unsignedTx,
      expected.checkpoints[0].unsignedTx,
      'Checkpoint does not match the expected construction and preserved value.',
    );
    const expectedInput = expected.arkTx.getInput(0);
    equal(
      details.input.witnessUtxo,
      expectedInput.witnessUtxo,
      'Payment prevout differs from checkpoint output.',
    );
    equal(
      details.input.tapLeafScript,
      expectedInput.tapLeafScript,
      'Payment must use the preserved cooperative checkpoint path.',
    );
    if (cp.inputIndexes.length) {
      indexes.push(i);
      const summary = inspectPsbt(cp.tx, [0], ctx);
      originals.push({ ...summary.signInputs[0], index: i });
    }
  }
  if (
    payment.version !== 3 ||
    payment.lockTime !== 0
  ) {
    reject('Unsupported Arkade transaction version or locktime.');
  }
  for (let i = 0; i < payment.inputsLength; i++) {
    if (payment.getInput(i).sequence !== 0xffffffff) {
      reject('Unexpected cooperative input sequence.');
    }
  }
  // Only final payment outputs contribute to the approval and fee check.
  const summary = inspectPsbt(payment, indexes, ctx);
  let anchorCount = 0;
  for (const out of summary.outputs) {
    const raw = payment.getOutput(out.index);
    if (stable(raw.script) === stable(P2A.script)) {
      if (
        raw.amount !== 0n ||
        out.index !== payment.outputsLength - 1
      ) {
        reject('Invalid SDK anchor.');
      }
      anchorCount++;
    } else if (!out.address || out.amount <= 0 || !Number.isSafeInteger(out.amount)) {
      reject('Only standard BTC payment outputs and SDK anchors are supported.');
    }
  }
  if (
    anchorCount !== 1 ||
    payment.outputsLength < 2
  ) {
    reject('The payment requires destinations and one SDK anchor.');
  }
  if (
    summary.fee === null ||
    summary.fee < 0 ||
    !Number.isSafeInteger(summary.fee)
  ) {
    reject('Invalid transaction fee.');
  }
  if (summary.fee > ctx.feeSanityBoundSats) {
    throw new PsbtRejectedError('FEE_TOO_HIGH', 'The transaction fee exceeds the wallet sanity bound.');
  }
  // The anchor is protocol structure, not a payout or a nonstandard-output warning.
  summary.outputs = summary.outputs.filter(
    (out) => stable(payment.getOutput(out.index).script) !== stable(P2A.script),
  );
  summary.flags = summary.flags.filter(
    (flag) => flag !== 'NONSTANDARD_OUTPUT' && !(flag === 'SWEEP' && summary.isPureContractCoSign),
  );
  return {
    summary: {
      payment: summary,
      checkpointCount: checkpoints.length,
      originalInputs: originals,
      fee: summary.fee,
    },
    arkadePsbt: canonical(payment),
    arkadeInputIndexes: indexes,
    checkpoints: checkpoints.map((cp) => ({ psbt: canonical(cp.tx), inputIndexes: cp.inputIndexes })),
  };
}

/** Merge only verified signature additions into the exact stored approval templates. */
export function prepareArkadeCheckpoints(
  approved: ValidatedArkadeTransaction,
  submitted: string[],
  operatorXOnly: string,
): string[] {
  try {
    if (
      !Array.isArray(submitted) ||
      submitted.length !== approved.checkpoints.length
    ) {
      reject('Incomplete checkpoint submission.');
    }
    const transactions = submitted.map(parsePsbt);
    const byId = new Map(transactions.map((tx) => [tx.id, tx]));
    if (byId.size !== transactions.length) reject('Duplicate checkpoint submission.');
    return approved.checkpoints.map((item) => {
      const stored = parsePsbt(item.psbt);
      const returned = byId.get(stored.id);
      if (!returned) reject('Submitted checkpoint was not approved.');
      equal(
        stored.unsignedTx,
        returned.unsignedTx,
        'Checkpoint transaction changed after approval.',
      );
      for (let i = 0; i < stored.outputsLength; i++) {
        equal(
          stored.getOutput(i),
          returned.getOutput(i),
          'Checkpoint output metadata changed after approval.',
        );
      }
      const { tapScriptSig: oldSigs, ...oldMetadata } = stored.getInput(0);
      const { tapScriptSig: newSigs, ...newMetadata } = returned.getInput(0);
      equal(oldMetadata, newMetadata, 'Checkpoint signing metadata changed after approval.');
      checkSignatures(returned, 0, [operatorXOnly]);
      const merged = [...(oldSigs ?? [])];
      for (const signature of newSigs ?? []) {
        const previous = merged.find(([key]) => stable(key) === stable(signature[0]));
        if (previous) equal(previous, signature, 'An existing checkpoint signature was replaced.');
        else merged.push(signature);
      }
      stored.updateInput(0, { tapScriptSig: merged });
      return canonical(stored);
    });
  } catch (error) {
    if (error instanceof PsbtRejectedError) throw error;
    reject('Malformed checkpoint completion.');
  }
}
