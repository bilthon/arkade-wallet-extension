import {
  Transaction,
  VtxoScript,
  decodeTapscript,
  getArkPsbtFields,
  VtxoTaprootTree,
  MultisigTapscript,
  CSVMultisigTapscript,
  CLTVMultisigTapscript,
  ConditionCSVMultisigTapscript,
  type NetworkName,
} from '@arkade-os/sdk';
import { base64, hex } from '@scure/base';

/**
 * SW-side PSBT decode + validation (M4, BUILD_PLAN Phase 3 Track E; PLAN.md §7).
 *
 * The signing approval is the highest-leverage attack surface in the wallet: a
 * malicious site hands us a PSBT and a list of inputs to sign and tries to trick the
 * user into authorizing a payout they didn't intend. So the SW NEVER trusts a
 * site-supplied summary — it parses the PSBT itself and produces the human diff the
 * approval window renders: every output (address + amount), which outputs are our own
 * change (detected by re-derivation, not by the site claiming so), the total leaving
 * the wallet, the total to external addresses, the fee, and which inputs we are being
 * asked to sign.
 *
 * Two signing shapes are recognized and rendered DIFFERENTLY:
 *  • OWN-COIN spend — the inputs we sign are coins we solely own. The diff above is the
 *    full story; the user is moving their own money.
 *  • CONTRACT CO-SIGN — an input spends a `VtxoScript` whose active tapleaf NAMES the
 *    user as one of several required signers but the coin is NOT solely the user's
 *    (2-of-3 escrow, HTLCs, the P2P-coordinator L1/L2/L3 leaves). The blanket
 *    "non-standard script → reject" guard would kill the exact flow this wallet exists
 *    to enable, so instead we decode the leaf, name the clause it satisfies, show the
 *    destination + amount, and tell the user they are adding "1 of N" signatures. Only
 *    leaves we genuinely cannot decode fall through to the reject path.
 *
 * This module is PURE and side-effect-free: it takes a parsed `Transaction` (or a raw
 * PSBT string) plus an `InspectContext` (the wallet's own keys/scripts/limits) and
 * returns a structured `PsbtSummary`. The background builds the context from the live
 * wallet; tests build it from a fake. No signing happens here — that's the handler's
 * job, gated on the user approving this summary.
 */

// ─── public shapes ────────────────────────────────────────────────────────────

/** Why a PSBT was rejected outright (never reaches the approval window). */
export class PsbtRejectedError extends Error {
  constructor(
    readonly code:
      | 'UNDECODABLE' // not a parseable PSBT
      | 'NO_INPUTS' // empty inputIndexes / nothing for us to sign
      | 'BAD_INPUT_INDEX' // an index out of range
      | 'NOT_OUR_INPUT' // an input we were asked to sign isn't ours and isn't a leaf we co-sign
      | 'FEE_TOO_HIGH', // fee above the sanity bound without an explicit override
    message: string,
  ) {
    super(message);
    this.name = 'PsbtRejectedError';
  }
}

/** Danger signals surfaced (NOT auto-rejected) for the user to weigh. */
export type DangerFlag =
  | 'SWEEP' // we sign every input and ~nothing returns to us (drains the wallet)
  | 'UNILATERAL_EXIT' // an input spends a CSV unilateral-exit leaf
  | 'OP_RETURN' // a data-carrier output
  | 'NONSTANDARD_OUTPUT'; // an output script we can't decode to an address

/** A decoded transaction output. */
export interface OutputSummary {
  index: number;
  /** Decoded address, or null when the script doesn't map to one (OP_RETURN, unknown). */
  address: string | null;
  amount: number; // sats
  /** True when re-derivation matched this output to one of our own scripts (change). */
  isOwnChange: boolean;
  /** Set for non-address outputs so the UI can label them. */
  kind?: 'op_return' | 'nonstandard';
}

/** The leaf clause an input satisfies (contract co-sign rendering). */
export type LeafClause =
  | 'cooperative' // plain N-of-N multisig (e.g. L1 release / dispute leaves)
  | 'timeout-refund' // CLTV multisig (absolute timelock refund)
  | 'unilateral-exit' // CSV multisig (relative timelock exit)
  | 'conditional' // condition + multisig (HTLC-style)
  | 'conditional-exit'; // condition + CSV multisig

/** A per-input classification for the inputs we've been asked to sign. */
export interface SignInputSummary {
  index: number;
  amount: number; // sats (from the input's witnessUtxo / known prevout value)
  /** 'own' = a coin we solely own; 'contract' = a co-signed VtxoScript leaf. */
  role: 'own' | 'contract';
  /** Contract co-sign details (present only when role === 'contract'). */
  contract?: {
    clause: LeafClause;
    /** x-only signer pubkeys named in the leaf (hex). Includes us + counterparties. */
    signers: string[];
    /** Total required signatures = signers.length (N-of-N). */
    required: number;
    /** Relative (CSV) or absolute (CLTV) timelock, when the leaf carries one. */
    timelock?: { kind: 'csv' | 'cltv'; value: string };
  };
}

/** The structured, trustworthy summary the approval window renders. */
export interface PsbtSummary {
  /** Network the wallet is on (drives address decoding + the HRP shown). */
  network: NetworkName;
  outputs: OutputSummary[];
  /** The inputs we were asked to sign, classified. */
  signInputs: SignInputSummary[];
  /** sats leaving the wallet (sum of inputs we sign − own change returned to us). */
  totalLeaving: number;
  /** sats going to addresses that are NOT our own (the external payout). */
  totalToExternal: number;
  /** Transaction fee in sats, or null when not all prevout values are known. */
  fee: number | null;
  /** Danger signals for the user to weigh (does not block on its own). */
  flags: DangerFlag[];
  /** True when ANY signed input is a contract co-sign (drives the distinct view). */
  isContractCoSign: boolean;
  /** True when EVERY signed input is a contract co-sign (no own-coin diff to show). */
  isPureContractCoSign: boolean;
}

/** The wallet facts the inspector needs — built from the live wallet (or a fake). */
export interface InspectContext {
  network: NetworkName;
  /** Our x-only public key, hex (32B). Used to detect us in a multisig leaf. */
  ownXOnly: string;
  /** The operator's x-only public key, hex (32B). Present in every collaborative
   *  Arkade leaf; excluded when counting "is this solely ours" so an operator co-sign
   *  doesn't read as a foreign party. */
  operatorXOnly: string;
  /** Hex pkScripts of outputs that are OUR OWN (Arkade address, boarding address, and
   *  any of our own single-owner VtxoScript outputs). Drives own-change detection. */
  ownScriptsHex: Set<string>;
  /** Dust floor in sats (operator `info.dust`); a smaller amount can't be a real output. */
  dustSats: number;
  /** Fee sanity bound in sats; a fee above this is rejected unless overridden. */
  feeSanityBoundSats: number;
}

// ─── parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a base64- or hex-encoded PSBT into a `Transaction`, tolerating the Arkade
 * custom PSBT fields (taptree, cosigner keys, …) that a strict parse would reject.
 * Throws `PsbtRejectedError('UNDECODABLE')` on anything that isn't a PSBT.
 */
export function parsePsbt(psbt: string): Transaction {
  const trimmed = psbt.trim();
  let bytes: Uint8Array;
  try {
    bytes = looksHex(trimmed) ? hex.decode(trimmed.toLowerCase()) : base64.decode(trimmed);
  } catch {
    throw new PsbtRejectedError('UNDECODABLE', 'The signing request is not a valid PSBT.');
  }
  try {
    // allowUnknown* so the Arkade vtxo/taptree custom fields don't throw, and so a
    // partially-built (no-witnessUtxo) checkpoint PSBT still parses.
    return Transaction.fromPSBT(bytes, {
      allowUnknown: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      allowLegacyWitnessUtxo: true,
      disableScriptCheck: true,
    });
  } catch {
    throw new PsbtRejectedError('UNDECODABLE', 'The signing request is not a valid PSBT.');
  }
}

function looksHex(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
}

// ─── the inspector ──────────────────────────────────────────────────────────────

/**
 * Inspect a parsed PSBT for the given `inputIndexes` against the wallet context, and
 * return the human diff the approval window renders. Throws `PsbtRejectedError` for the
 * cases that must never reach the user (undecodable handled in {@link parsePsbt};
 * bad/empty indexes; an input we can neither own nor co-sign; a fee above the bound
 * without `allowHighFee`).
 */
export function inspectPsbt(
  tx: Transaction,
  inputIndexes: number[],
  ctx: InspectContext,
  opts: { allowHighFee?: boolean } = {},
): PsbtSummary {
  if (inputIndexes.length === 0) {
    throw new PsbtRejectedError('NO_INPUTS', 'No inputs were specified to sign.');
  }
  const indexes = [...new Set(inputIndexes)].sort((a, b) => a - b);
  for (const i of indexes) {
    if (!Number.isInteger(i) || i < 0 || i >= tx.inputsLength) {
      throw new PsbtRejectedError('BAD_INPUT_INDEX', `Input index ${i} is out of range.`);
    }
  }

  const outputs = decodeOutputs(tx, ctx);
  const signInputs = indexes.map((i) => classifyInput(tx, i, ctx));

  // Totals. "Own change" = outputs we re-derived to our own scripts. External = the rest
  // of the address outputs (data/nonstandard outputs carry no payout addressable to us).
  const ownChangeSats = outputs
    .filter((o) => o.isOwnChange)
    .reduce((s, o) => s + o.amount, 0);
  const totalToExternal = outputs
    .filter((o) => !o.isOwnChange && o.address !== null)
    .reduce((s, o) => s + o.amount, 0);

  const signedInputSats = signInputs.reduce((s, si) => s + si.amount, 0);
  const totalLeaving = Math.max(0, signedInputSats - ownChangeSats);

  const fee = computeFee(tx);

  // Fee sanity bound (own-coin spends only — a contract co-sign's fee is set by the
  // contract author, not us, and the input values may be unknown to us).
  const isPureContractCoSign =
    signInputs.length > 0 && signInputs.every((si) => si.role === 'contract');
  if (
    !opts.allowHighFee &&
    !isPureContractCoSign &&
    fee !== null &&
    fee > ctx.feeSanityBoundSats
  ) {
    throw new PsbtRejectedError(
      'FEE_TOO_HIGH',
      `The fee (${fee} sats) is unusually high (over ${ctx.feeSanityBoundSats} sats). ` +
        `Approve again to override if this is intentional.`,
    );
  }

  const flags = collectFlags(tx, outputs, signInputs, ownChangeSats, ctx);
  const isContractCoSign = signInputs.some((si) => si.role === 'contract');

  return {
    network: ctx.network,
    outputs,
    signInputs,
    totalLeaving,
    totalToExternal,
    fee,
    flags,
    isContractCoSign,
    isPureContractCoSign,
  };
}

// ─── outputs ────────────────────────────────────────────────────────────────────

function decodeOutputs(tx: Transaction, ctx: InspectContext): OutputSummary[] {
  const out: OutputSummary[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const amount = Number(o.amount ?? 0n);
    const scriptHex = o.script ? hex.encode(o.script) : '';
    const isOwnChange = scriptHex !== '' && ctx.ownScriptsHex.has(scriptHex);

    if (isOpReturn(o.script)) {
      out.push({ index: i, address: null, amount, isOwnChange: false, kind: 'op_return' });
      continue;
    }

    const address = safeOutputAddress(tx, i, ctx.network);
    if (address === null) {
      out.push({ index: i, address: null, amount, isOwnChange, kind: 'nonstandard' });
    } else {
      out.push({ index: i, address, amount, isOwnChange });
    }
  }
  return out;
}

function isOpReturn(script: Uint8Array | undefined): boolean {
  // OP_RETURN is 0x6a as the first opcode.
  return !!script && script.length > 0 && script[0] === 0x6a;
}

function safeOutputAddress(tx: Transaction, i: number, network: NetworkName): string | null {
  try {
    const addr = tx.getOutputAddress(i, btcNetwork(network));
    return addr ?? null;
  } catch {
    return null;
  }
}

// ─── inputs (own vs contract co-sign) ────────────────────────────────────────────

function classifyInput(tx: Transaction, index: number, ctx: InspectContext): SignInputSummary {
  const input = tx.getInput(index);
  const amount = Number(input.witnessUtxo?.amount ?? 0n);

  // The active leaf is the input's tapLeafScript (the leaf the spender chose). Decode it
  // and see who it names. If it doesn't name us, this isn't ours to sign — reject. If it
  // names ONLY us (+ the operator), it's an own-coin spend. If it names us AND a real
  // counterparty, it's a contract co-sign.
  const leafScript = activeLeafScript(input);
  if (!leafScript) {
    // No tapleaf info (e.g. a key-path / non-tapscript input). We can only treat it as
    // "ours" if its prevout script is one of ours; otherwise it's not ours to sign.
    const prevHex = input.witnessUtxo?.script
      ? hex.encode(input.witnessUtxo.script)
      : '';
    if (prevHex !== '' && ctx.ownScriptsHex.has(prevHex)) {
      return { index, amount, role: 'own' };
    }
    throw new PsbtRejectedError(
      'NOT_OUR_INPUT',
      `Input ${index} can't be decoded to a script the wallet can sign.`,
    );
  }

  // SECURITY (defense-in-depth): the `tapLeafScript` bytes are site-supplied, and neither
  // `decodeTapscript` nor `Identity.sign` checks that this leaf is actually committed by
  // the taproot OUTPUT we're spending. An unverified leaf could mislabel a real spend path
  // (e.g. forge `Multisig(O, U)` so a foreign input reads as a safe own-coin spend, hiding
  // a contract co-sign or dodging the fee bound). On-chain consensus would reject the
  // resulting signature, but the APPROVAL DIFF the user sees must be trustworthy on its
  // own. So we verify the leaf is committed by the input's witnessUtxo script before we
  // trust ANY of its bytes (clause, signers, role). Inputs we can't verify are rejected.
  verifyLeafCommitment(tx, index, input, leafScript);

  let decoded: ReturnType<typeof decodeTapscript>;
  try {
    decoded = decodeTapscript(leafScript);
  } catch {
    throw new PsbtRejectedError(
      'NOT_OUR_INPUT',
      `Input ${index} uses a script the wallet does not recognize.`,
    );
  }

  const pubkeys = leafPubkeys(decoded);
  const signersHex = pubkeys.map((p) => hex.encode(p));
  const namesUs = signersHex.includes(ctx.ownXOnly);
  if (!namesUs) {
    throw new PsbtRejectedError(
      'NOT_OUR_INPUT',
      `Input ${index} does not name this wallet as a signer.`,
    );
  }

  // Counterparties = named signers that are neither us nor the operator. If there are
  // none, this coin is solely ours (the operator co-sign is the normal Arkade collab
  // path, not a foreign party) → own-coin spend. Otherwise it's a contract co-sign.
  const counterparties = signersHex.filter(
    (h) => h !== ctx.ownXOnly && h !== ctx.operatorXOnly,
  );
  if (counterparties.length === 0) {
    return { index, amount, role: 'own' };
  }

  return {
    index,
    amount,
    role: 'contract',
    contract: {
      clause: clauseOf(decoded.type),
      signers: signersHex,
      required: signersHex.length,
      timelock: leafTimelock(decoded),
    },
  };
}

/**
 * The active tapleaf script bytes for an input: the script half of its `tapLeafScript`
 * field, or null when the input carries no tapscript leaf.
 *
 * The PSBT `tapLeafScript` field (BIP371) is `[{version,internalKey,merklePath}, value]`
 * where `value = <script bytes> || <1-byte leaf version>` (e.g. the trailing `0xc0`).
 * `decodeTapscript` wants the script WITHOUT that trailing leaf-version byte, so we
 * strip it. A taproot leaf-version byte is always even and in the 0xc0..0xfe range; we
 * only strip when the last byte looks like one, so a (hypothetical) field without the
 * suffix isn't truncated.
 */
function activeLeafScript(input: ReturnType<Transaction['getInput']>): Uint8Array | null {
  const tls = (input as { tapLeafScript?: Array<[unknown, Uint8Array]> }).tapLeafScript;
  if (!Array.isArray(tls) || tls.length === 0) return null;
  const first = tls[0];
  if (!Array.isArray(first) || !(first[1] instanceof Uint8Array)) return null;
  const value = first[1];
  if (value.length === 0) return null;
  const last = value[value.length - 1];
  const isLeafVersionByte = last >= 0xc0 && (last & 1) === 0; // 0xc0, 0xc2, … 0xfe
  return isLeafVersionByte ? value.slice(0, -1) : value;
}

/**
 * Verify that the active tapleaf is genuinely committed by the taproot OUTPUT the input
 * spends — so the leaf bytes (and everything we derive from them) are trustworthy, not
 * just attacker-supplied. Two checks, both against the PSBT's own data:
 *   1. Rebuild the `VtxoScript` from the input's taptree field (`VtxoTaprootTree`) and
 *      require its pkScript to EQUAL the input's `witnessUtxo.script`. This proves the
 *      leaf set is the one committed by the spent output's taproot key (the output key is
 *      the taproot tweak of that exact tree — a forged tree yields a different pkScript).
 *   2. Require the active leaf to be one of that tree's leaves. This proves the chosen
 *      spend path is actually in the committed tree, not an extra leaf bolted onto the
 *      `tapLeafScript` field.
 * Any input missing the taptree / witnessUtxo, or failing either check, is `NOT_OUR_INPUT`.
 */
function verifyLeafCommitment(
  tx: Transaction,
  index: number,
  input: ReturnType<Transaction['getInput']>,
  leafScript: Uint8Array,
): void {
  const prevScript = input.witnessUtxo?.script;
  if (!prevScript) {
    throw new PsbtRejectedError(
      'NOT_OUR_INPUT',
      `Input ${index} has no prevout to verify the spend against.`,
    );
  }

  let trees: Uint8Array[];
  try {
    trees = getArkPsbtFields(tx, index, VtxoTaprootTree);
  } catch {
    trees = [];
  }
  if (trees.length === 0) {
    throw new PsbtRejectedError(
      'NOT_OUR_INPUT',
      `Input ${index} carries no taproot tree to verify the spend path against.`,
    );
  }

  let rebuilt: InstanceType<typeof VtxoScript>;
  try {
    rebuilt = VtxoScript.decode(trees[0]);
  } catch {
    throw new PsbtRejectedError(
      'NOT_OUR_INPUT',
      `Input ${index} has an undecodable taproot tree.`,
    );
  }

  // (1) the tree must build the exact output we're spending.
  if (hex.encode(rebuilt.pkScript) !== hex.encode(prevScript)) {
    throw new PsbtRejectedError(
      'NOT_OUR_INPUT',
      `Input ${index}'s spend path is not committed by the coin it spends.`,
    );
  }

  // (2) the active leaf must be one of that committed tree's leaves.
  const leafHex = hex.encode(leafScript);
  const committed = rebuilt.scripts.some((s) => hex.encode(s) === leafHex);
  if (!committed) {
    throw new PsbtRejectedError(
      'NOT_OUR_INPUT',
      `Input ${index}'s spend path is not part of the coin's taproot tree.`,
    );
  }
}

/** Pull the signer pubkeys out of any multisig-bearing leaf (all our leaf types carry
 *  `params.pubkeys`). Returns [] for a shape with no pubkeys. */
function leafPubkeys(decoded: ReturnType<typeof decodeTapscript>): Uint8Array[] {
  const params = decoded.params as { pubkeys?: Uint8Array[] };
  return params.pubkeys ?? [];
}

/**
 * Map a tapscript type to the human clause label shown in the co-sign view. `decoded.type`
 * is a plain string at runtime — the SDK's `TapscriptType` enum is erased in its ESM build
 * (it reads `undefined`), so we match the string values directly rather than the enum.
 */
function clauseOf(type: string): LeafClause {
  switch (type) {
    case 'multisig':
      return 'cooperative';
    case 'cltv-multisig':
      return 'timeout-refund';
    case 'csv-multisig':
      return 'unilateral-exit';
    case 'condition-multisig':
      return 'conditional';
    case 'condition-csv-multisig':
      return 'conditional-exit';
    default:
      return 'cooperative';
  }
}

/** The timelock a leaf carries, if any (CSV relative / CLTV absolute). */
function leafTimelock(
  decoded: ReturnType<typeof decodeTapscript>,
): { kind: 'csv' | 'cltv'; value: string } | undefined {
  if (
    CSVMultisigTapscript.is(decoded) ||
    ConditionCSVMultisigTapscript.is(decoded)
  ) {
    const tl = (decoded.params as { timelock?: { value: bigint } }).timelock;
    if (tl) return { kind: 'csv', value: tl.value.toString() };
  }
  if (CLTVMultisigTapscript.is(decoded)) {
    const at = (decoded.params as { absoluteTimelock?: bigint }).absoluteTimelock;
    if (at !== undefined) return { kind: 'cltv', value: at.toString() };
  }
  return undefined;
}

// ─── fee + flags ─────────────────────────────────────────────────────────────────

/** The fee in sats, or null when not every input carries a known prevout value (we
 *  refuse to invent a fee from partial data). `tx.fee` throws in that case. */
function computeFee(tx: Transaction): number | null {
  try {
    return Number(tx.fee);
  } catch {
    return null;
  }
}

function collectFlags(
  tx: Transaction,
  outputs: OutputSummary[],
  signInputs: SignInputSummary[],
  ownChangeSats: number,
  _ctx: InspectContext,
): DangerFlag[] {
  const flags = new Set<DangerFlag>();

  if (outputs.some((o) => o.kind === 'op_return')) flags.add('OP_RETURN');
  if (outputs.some((o) => o.kind === 'nonstandard')) flags.add('NONSTANDARD_OUTPUT');

  // Unilateral exit: an input we sign spends a CSV (relative-timelock) exit leaf.
  if (
    signInputs.some(
      (si) => si.contract?.clause === 'unilateral-exit' || si.contract?.clause === 'conditional-exit',
    )
  ) {
    flags.add('UNILATERAL_EXIT');
  }

  // Sweep: we sign every input in the tx AND ~nothing returns to us as change — the tx
  // drains the wallet to external destinations. (A normal send keeps change.)
  const weSignAll = signInputs.length === tx.inputsLength && tx.inputsLength > 0;
  if (weSignAll && ownChangeSats === 0 && outputs.some((o) => o.address !== null && !o.isOwnChange)) {
    flags.add('SWEEP');
  }

  return [...flags];
}

// ─── network mapping ─────────────────────────────────────────────────────────────

/**
 * Map an Arkade `NetworkName` to the `@scure/btc-signer` BTC_NETWORK descriptor used by
 * `Transaction.getOutputAddress`. We avoid importing the SDK's `networks` map here to
 * keep this module's import graph small and SDK-stub-friendly in tests; the parameters
 * (bech32 HRP + version bytes) are the standard Bitcoin ones.
 */
function btcNetwork(network: NetworkName) {
  // bitcoin mainnet; everything else is a test network with `tb`/`bcrt`-style params.
  if (network === 'bitcoin') {
    return { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
  }
  if (network === 'regtest') {
    return { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
  }
  // signet / testnet / mutinynet all use the testnet params + `tb` HRP.
  return { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
}

/**
 * Re-derive the set of our own output scripts (hex pkScripts) from the wallet so the
 * inspector can flag change. Imported by the background; kept here so the own-change
 * rule lives next to where it's consumed. The Arkade VTXO output script is the
 * `VtxoScript` pkScript for the wallet's own address; the boarding output is its own
 * taproot script. We accept a list of raw scripts and hex-encode them.
 */
export function ownScriptsFrom(scripts: Uint8Array[]): Set<string> {
  return new Set(scripts.map((s) => hex.encode(s)));
}

// re-export so callers (background) can decode a taptree to recover own VtxoScript outputs.
export { VtxoScript, VtxoTaprootTree, getArkPsbtFields, MultisigTapscript };
