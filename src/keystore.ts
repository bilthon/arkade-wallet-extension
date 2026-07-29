import {
  decryptVault,
  encryptVault,
  generateMnemonic,
  validateMnemonic,
  type VaultBlob,
} from './crypto';
import { getNetwork, getVault, getVaultAndNetwork, hasVault, setVault } from './storage';
import {
  getRuntimeVersion,
  getSessionNetwork,
  isUnlocked,
  openSession,
  prepareRuntimeNetworkSwitch,
  type PreparedRuntimeNetworkSwitch,
} from './wallet-runtime';
import { networkConfig } from './wallet';
import type { NetworkName } from '@arkade-os/sdk';

/**
 * Persistent encrypted wallet key material and password authentication.
 *
 * This module creates, imports, decrypts, and re-encrypts the mnemonic vault. Plaintext
 * mnemonics remain scoped to those operations and are handed directly to wallet-runtime,
 * which constructs the live identity and owns unlock state. No plaintext mnemonic or raw
 * seed is retained here.
 */

/**
 * Lock state for the popup router. `hasVault` decides welcome-vs-unlock; `unlocked`
 * is authoritative runtime state. After an SW kill that state is gone, so the next
 * sensitive action requires the password again.
 */
export interface LockState {
  hasVault: boolean;
  unlocked: boolean;
}

export async function getLockState(): Promise<LockState> {
  return { hasVault: await hasVault(), unlocked: isUnlocked() };
}

/**
 * Backup re-reveal behind re-auth. Re-decrypts the vault with the supplied password
 * and returns the mnemonic for a one-time tap-to-reveal. We re-auth from the vault
 * (not the in-memory mnemonic) so the reveal always costs the password — even when
 * already unlocked. A wrong password throws from `decryptVault`; we never return the
 * phrase on failed auth.
 *
 * Apart from the one-time creation response, this is the only path by which the
 * mnemonic crosses the SW boundary, and only on an explicit user request.
 */
export async function getMnemonicForBackup(password: string): Promise<string> {
  const { vault, network } = await getVaultAndNetwork();
  if (!vault) throw new Error('getMnemonicForBackup: no vault');
  return decryptVault(vault, password, network); // throws on bad password/tamper
}

/**
 * Check the password and get a network switch ready, without changing anything yet.
 * Returns `null` when the requested network is the one already active.
 *
 * The vault binds the encrypted mnemonic to its network via the AES-GCM
 * additional-data (`"arkade-vault-v1" + network`), so a plain `setNetwork` call
 * would leave the vault undecryptable on the new network. So we re-auth under the
 * CURRENT network, then re-encrypt the same mnemonic under the NEW network's AAD.
 *
 * Preparation authenticates and stages the target data without touching either live
 * runtime. The serialized network-switch coordinator fences those runtimes only after
 * this returns, so a password typo cannot stop a Lightning swap in progress.
 *
 * Boundary: the mnemonic stays in the SW, only the password crosses in — same
 * contract as `getMnemonicForBackup`. A wrong password (or tamper) throws from
 * `decryptVault` and leaves the stored vault + network UNCHANGED (fail-closed).
 */
export interface PreparedNetworkSwitch {
  readonly sourceNetwork: NetworkName;
  readonly targetNetwork: NetworkName;
  readonly vault: VaultBlob;
  readonly runtime: PreparedRuntimeNetworkSwitch;
}

export async function prepareNetworkSwitch(
  newNetwork: NetworkName,
  password: string,
): Promise<PreparedNetworkSwitch | null> {
  networkConfig(newNetwork); // reject an unrecognized message payload before any mutation
  const sourceRuntime = getRuntimeVersion();
  const { vault, network: current } = await getVaultAndNetwork();
  if (!vault) throw new Error('prepareNetworkSwitch: no vault');
  if (sourceRuntime.network !== null && sourceRuntime.network !== current) {
    throw new Error('prepareNetworkSwitch: runtime and stored networks disagree');
  }
  if (newNetwork === current) return null; // no-op
  // Re-auth under the CURRENT network (fail-closed: wrong password/tamper throws from decryptVault).
  const mnemonic = await decryptVault(vault, password, current);
  // Re-encrypt the SAME mnemonic under the NEW network's AAD. Nothing is stored until
  // the coordinator commits the prepared value, so everything above is safe to abandon.
  const newVault = await encryptVault(mnemonic, password, newNetwork);
  const runtime = prepareRuntimeNetworkSwitch(mnemonic, newNetwork, sourceRuntime);

  return {
    sourceNetwork: current,
    targetNetwork: newNetwork,
    vault: newVault,
    runtime,
  };
}

// ─── Create / import ─────────────────────────────────────────────────────────

/**
 * First-run wallet creation: generate a fresh mnemonic, encrypt it under the
 * password for the active network, persist the vault, and leave the wallet
 * UNLOCKED in memory. Returns the mnemonic so the UI can show the backup flow
 * once (tap-to-reveal); the caller must not persist it anywhere else.
 */
export async function createWallet(
  password: string,
  strength: 128 | 256 = 128,
): Promise<string> {
  if (await getVault()) throw new Error('createWallet: a vault already exists');
  const mnemonic = generateMnemonic(strength);
  const network = await getNetwork();
  await setVault(await encryptVault(mnemonic, password, network));
  await openSession(mnemonic, network);
  return mnemonic;
}

/** Import an existing mnemonic (validated), encrypt + persist, and unlock. */
export async function importWallet(mnemonic: string, password: string): Promise<void> {
  if (await getVault()) throw new Error('importWallet: a vault already exists');
  if (!validateMnemonic(mnemonic)) throw new Error('importWallet: invalid mnemonic');
  const network = await getNetwork();
  await setVault(await encryptVault(mnemonic, password, network));
  await openSession(mnemonic, network);
}

// ─── Unlock ──────────────────────────────────────────────────────────────────

/**
 * Unlock by decrypting the stored vault. A wrong password (or a tampered vault)
 * throws from `decryptVault` and the wallet stays locked. On success the runtime owns
 * the derived identity and the auto-lock timer (re)starts.
 */
export async function unlock(password: string): Promise<void> {
  const { vault, network } = await getVaultAndNetwork();
  if (!vault) throw new Error('unlock: no vault');
  const mnemonic = await decryptVault(vault, password, network); // throws on bad password/tamper
  if (isUnlocked()) {
    if (getSessionNetwork() !== network) {
      throw new Error('unlock: runtime and stored networks disagree');
    }
    return;
  }
  await openSession(mnemonic, network);
}
