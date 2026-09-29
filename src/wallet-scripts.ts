import { DefaultVtxo, DelegateVtxo, sequenceToTimelock, type Contract, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';

/**
 * Reconstruct a built-in wallet script before trusting its stored ownership metadata.
 * A matching key in an arbitrary contract is not sufficient to classify it as change.
 */
export function ownedContractScript(contract: Contract, ownXOnly: string): Uint8Array | null {
  if (contract.type !== 'default' && contract.type !== 'delegate') return null;
  try {
    const params = contract.params;
    if (params.pubKey?.toLowerCase() !== ownXOnly.toLowerCase()) return null;
    const sequence = Number(params.csvTimelock);
    if (!/^\d+$/.test(params.csvTimelock) || !Number.isSafeInteger(sequence)
      || sequence < 0 || sequence > 0xffffffff) return null;
    const options = {
      pubKey: hex.decode(params.pubKey),
      serverPubKey: hex.decode(params.serverPubKey),
      csvTimelock: sequenceToTimelock(sequence),
    };
    const script = contract.type === 'delegate'
      ? new DelegateVtxo.Script({ ...options, delegatePubKey: hex.decode(params.delegatePubKey) })
      : new DefaultVtxo.Script(options);
    return hex.encode(script.pkScript) === contract.script.toLowerCase() ? script.pkScript : null;
  } catch {
    return null;
  }
}

/**
 * Collect hex pkScripts for the live offchain (VTXO) and boarding scripts, plus
 * verified default/delegate contracts stored for this key. Historical scripts remain
 * recognizable as our own change; stored custom contracts are excluded.
 */
export async function ownScriptsFor(wallet: Wallet, ownXOnly: string): Promise<Set<string>> {
  const scripts = new Set<string>();
  // The accessors throw before the wallet has a script; own-change then just won't match it.
  try {
    scripts.add(hex.encode(wallet.offchainTapscript.pkScript));
  } catch { /* no offchain script */ }
  try {
    scripts.add(hex.encode(wallet.boardingTapscript.pkScript));
  } catch { /* no boarding script */ }

  const manager = await wallet.getContractManager();
  for (const contract of await manager.getContracts({ type: ['default', 'delegate'] })) {
    if (typeof contract.script !== 'string') continue;
    // A stored script we already derived ourselves needs no second (costly) re-derivation;
    // an unrecognized one still goes through the full ownership check below.
    if (scripts.has(contract.script.toLowerCase())) continue;
    const script = ownedContractScript(contract, ownXOnly);
    if (script) scripts.add(hex.encode(script));
  }
  return scripts;
}

/** Find verified wallet scripts usable by this delegate, including historical receiving scripts. */
export async function delegateCompatibleScripts(
  wallet: Wallet, ownXOnly: string, delegatePublicKey: string,
): Promise<Set<string>> {
  const manager = await wallet.getContractManager();
  const contracts = await manager.getContracts({ type: ['delegate'] });
  // Approval uses a compressed key; stored scripts use the x-only key.
  const delegateKey = delegatePublicKey.slice(2).toLowerCase();
  const scripts = new Set<string>();
  for (const contract of contracts) {
    if (contract.type !== 'delegate') continue;
    const script = ownedContractScript(contract, ownXOnly);
    if (script && contract.params.delegatePubKey.toLowerCase() === delegateKey) {
      scripts.add(hex.encode(script));
    }
  }
  return scripts;
}
