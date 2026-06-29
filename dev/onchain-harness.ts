// Dev-only E2E: fund a 2-of-2 taproot ON-CHAIN via nigiri regtest, have the extension
// co-sign a real spend, add the counterparty sig in-page, finalize, and BROADCAST on-chain.
//
// Unlike harness.ts (sign-only, proves the partial sig is *present*), this proves the sig is
// *cryptographically valid* — bitcoind itself accepts the finalized tx. It's a plain on-chain
// taproot script-path spend, NOT Arkade's off-chain operator flow (a separate, larger effort).
//
// Flow (one click): build Multisig([you, randomX]) escrow → show its bcrt1p… funding address →
// you faucet+mine → poll esplora for the UTXO → build a v2 spend PSBT (carrying the Arkade
// VtxoTaprootTree field signPsbt requires) → signPsbt (extension co-signs YOU) → add X in-page →
// finalize (btc-signer builds the tr_ns witness natively) → POST /tx to nigiri esplora.

import {
  SingleKey,
  VtxoScript,
  MultisigTapscript,
  Transaction,
  setArkPsbtField,
  VtxoTaprootTree,
  verifyTapscriptSignatures,
  networks,
} from '@arkade-os/sdk';
import { Address, OutScript } from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';

const ESPLORA = 'http://localhost:30000';
const FEE_SATS = 1000n;

// The page's inline script exposes its timestamped logger as window.appLog.
const log: (label: string, value: unknown) => void =
  (window as { appLog?: (l: string, v: unknown) => void }).appLog ??
  ((l, v) => console.log(l, v));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed?: boolean };
}

// Poll esplora until a CONFIRMED UTXO appears at the address (so the mine step gates progress).
async function pollForUtxo(addr: string): Promise<EsploraUtxo> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${ESPLORA}/address/${addr}/utxo`);
    if (res.ok) {
      const utxos: EsploraUtxo[] = await res.json();
      const confirmed = utxos.find((u) => u.status?.confirmed);
      if (confirmed) return confirmed;
    }
    await sleep(2000);
  }
  throw new Error(`No confirmed UTXO at ${addr} after 120s — did the faucet + mine commands run?`);
}

async function runOnchainCoSignTest(): Promise<void> {
  const w = (window as { arkadeWallet?: any }).arkadeWallet;
  if (!w) {
    log('on-chain co-sign', new Error('window.arkadeWallet is undefined — is the extension loaded?'));
    return;
  }
  const destAddr = (document.getElementById('onchainDest') as HTMLInputElement | null)?.value.trim();
  if (!destAddr) {
    log('on-chain co-sign', new Error('Paste a destination first (run `nigiri rpc getnewaddress`).'));
    return;
  }

  try {
    // 0. Our key (extension) + a random counterparty key X we KEEP (so we can co-sign as X).
    await w.connect();
    const { xOnly } = await w.getPublicKey();
    const U = hex.decode(xOnly);
    const xKey = SingleKey.fromHex(hex.encode(crypto.getRandomValues(new Uint8Array(32))));
    const X = await xKey.xOnlyPublicKey();

    // Escrow: one cooperative leaf Multisig(U, X) (2-of-2, N-of-N → contract co-sign, no operator).
    const l1 = MultisigTapscript.encode({ pubkeys: [U, X] }).script;
    const escrow = new VtxoScript([l1]);
    const leaf = escrow.findLeaf(hex.encode(l1)); // [controlBlock, script] — don't hand-build

    // 1. On-chain funding address + the exact commands the user runs.
    const fundingAddr = Address(networks.regtest).encode(OutScript.decode(escrow.pkScript));
    log('① fund this address, then mine 1 block', {
      fundingAddress: fundingAddr,
      faucet: `nigiri faucet ${fundingAddr} 0.001`,
      mine: 'nigiri rpc --generate 1',
      destination: destAddr,
    });

    // 2. Wait for the confirmed funding UTXO.
    log('② polling esplora for the confirmed UTXO…', `${ESPLORA}/address/${fundingAddr}/utxo`);
    const utxo = await pollForUtxo(fundingAddr);
    log('② funded', utxo);

    // 3. Build the v2 on-chain spend PSBT. setArkPsbtField(VtxoTaprootTree) is non-optional —
    //    signPsbt's verifyLeafCommitment rejects the input without it.
    const out = BigInt(utxo.value) - FEE_SATS;
    if (out < 330n) throw new Error(`Funded ${utxo.value} sats — too low to cover fee + dust.`);
    const tx = new Transaction({
      version: 2,
      allowUnknown: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    tx.addInput({
      txid: utxo.txid, // esplora display-order hex string — btc-signer reverses internally
      index: utxo.vout,
      witnessUtxo: { script: escrow.pkScript, amount: BigInt(utxo.value) },
      tapLeafScript: [leaf],
    });
    setArkPsbtField(tx, 0, VtxoTaprootTree, escrow.encode());
    tx.addOutput({ script: OutScript.encode(Address(networks.regtest).decode(destAddr)), amount: out });
    const psbtB64 = base64.encode(tx.toPSBT());
    log('③ built v2 spend PSBT', { inSats: utxo.value, outSats: Number(out), feeSats: Number(FEE_SATS) });

    // 4. Extension co-signs YOU (approval popup) → add X in-page → finalize.
    const extSignedB64: string = await w.signPsbt({ psbt: psbtB64, inputIndexes: [0] });
    let signed = Transaction.fromPSBT(base64.decode(extSignedB64), {
      allowUnknown: true,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    signed = await xKey.sign(signed, [0]); // appends X's partial sig, keeps the extension's
    verifyTapscriptSignatures(signed, 0, [hex.encode(U), hex.encode(X)]); // throws if either is bad/missing
    signed.finalize(); // builds [sig_X, sig_U, leafScript, controlBlock] for <U> CSV <X> CS
    const rawHex = signed.hex;
    log('④ co-signed (you + X) + finalized', { rawTxHex: rawHex });

    // 5. Broadcast on-chain (plain string body = text/plain → CORS-simple, no preflight).
    const res = await fetch(`${ESPLORA}/tx`, { method: 'POST', body: rawHex });
    const body = await res.text();
    if (!res.ok) {
      log('⑤ broadcast REJECTED ✗', new Error(`${res.status}: ${body}`));
      return;
    }
    log('⑤ broadcast ACCEPTED ✓ — bitcoind validated the signature', {
      txid: body,
      confirm: 'nigiri rpc --generate 1',
      verifyDest: `${ESPLORA}/address/${destAddr}/utxo`,
    });
  } catch (err) {
    log('on-chain co-sign threw', err);
  }
}

document.getElementById('onchainCoSignTest')?.addEventListener('click', runOnchainCoSignTest);
