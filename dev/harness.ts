// Dev-only test harness: drives a LIVE, sign-only end-to-end test of the wallet's
// `signPsbt` contract-co-sign path through the real provider + approval window.
//
// It builds an Arkade escrow `VtxoScript` with a 2-of-2 `Multisig([you, random])` leaf
// (the user + a random counterparty → classifies as a CONTRACT co-sign, no operator
// needed) and an offchain spend PSBT, then calls `window.arkadeWallet.signPsbt(...)`
// and verifies the returned PSBT carries ONLY the user's partial Schnorr sig and is
// UNFINALIZED. No funding, no operator, no broadcast — nothing leaves the page except
// the call to the wallet. Recipe mirrors src/psbt-inspect.test.ts + sign-handlers.test.ts.

import {
  SingleKey,
  VtxoScript,
  MultisigTapscript,
  CSVMultisigTapscript,
  buildOffchainTx,
  Transaction,
} from '@arkade-os/sdk';
import { hex, base64 } from '@scure/base';

// The page's inline script exposes its timestamped logger as window.appLog.
const log: (label: string, value: unknown) => void =
  (window as { appLog?: (l: string, v: unknown) => void }).appLog ??
  ((l, v) => console.log(l, v));

async function runCoSignTest(): Promise<void> {
  const w = (window as { arkadeWallet?: any }).arkadeWallet;
  if (!w) {
    log('co-sign test', new Error('window.arkadeWallet is undefined — is the extension loaded?'));
    return;
  }

  try {
    // 1. Connect + our identity key (signPsbt requires connected + unlocked).
    await w.connect();
    const { xOnly } = await w.getPublicKey();
    const U = hex.decode(xOnly); // our 32-byte x-only key

    // 2. A random counterparty makes the leaf a CONTRACT co-sign (no operator needed).
    const xKey = SingleKey.fromHex(hex.encode(crypto.getRandomValues(new Uint8Array(32))));
    const X = await xKey.xOnlyPublicKey();

    // 3. Escrow VtxoScript: a single cooperative leaf Multisig(U, X) (2-of-2, N-of-N).
    const l1 = MultisigTapscript.encode({ pubkeys: [U, X] }).script;
    const escrow = new VtxoScript([l1]);
    const leaf = escrow.findLeaf(hex.encode(l1)); // tapLeafScript tuple (don't hand-build)

    // 4. Checkpoint leaf buildOffchainTx needs (operator-only CSV in the real flow; any
    //    key works for a sign-only test — reuse X).
    const cp = CSVMultisigTapscript.encode({ pubkeys: [X], timelock: { value: 144n, type: 'blocks' } });

    // 5. Destination: any P2TR script (so the approval shows a real bcrt1… address + amount).
    const dest = new VtxoScript([MultisigTapscript.encode({ pubkeys: [U, X] }).script]).pkScript;

    // 6. Build the offchain spend PSBT (unfinalized, ready for partial sigs).
    const { arkTx } = buildOffchainTx(
      [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, tapLeafScript: leaf, tapTree: escrow.encode() }],
      [{ script: dest, amount: 99_000n }],
      cp,
    );
    const psbt = base64.encode(arkTx.toPSBT());
    log('built escrow co-sign PSBT', { you: xOnly, counterparty: hex.encode(X), psbt });

    // 7. Sign LIVE through the extension — the approval window should render the
    //    contract co-sign view ("1 of 2", clause cooperative, dest + 99,000).
    const out: string = await w.signPsbt({ psbt, inputIndexes: [0] });

    // 8. Verify: only OUR partial sig, unfinalized.
    const signed = Transaction.fromPSBT(base64.decode(out), {
      allowUnknown: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    const sigs = signed.getInput(0).tapScriptSig ?? [];
    const onlyOurs = sigs.length === 1 && hex.encode(sigs[0][0].pubKey) === xOnly;
    const unfinalized = signed.isFinal === false;
    const pass = onlyOurs && unfinalized;

    log(pass ? 'co-sign test → PASS ✓' : 'co-sign test → FAIL ✗', {
      tapScriptSigCount: sigs.length,
      signerPubKey: sigs[0] ? hex.encode(sigs[0][0].pubKey) : null,
      ourPubKey: xOnly,
      isFinal: signed.isFinal,
      signedPsbt: out,
    });
  } catch (err) {
    log('co-sign test threw', err);
  }
}

document.getElementById('coSignTest')?.addEventListener('click', runCoSignTest);
