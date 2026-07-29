import { decryptVault, encryptVault, generateMnemonic, validateMnemonic } from './crypto';
import { getNetwork, getVault, hasVault, setVault, setVaultAndNetwork } from './storage';
import { getSessionNetwork, isUnlocked, openSession } from './wallet-runtime';
import { clearSnapshot } from './wallet-cache';
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
  const blob = await getVault();
  if (!blob) throw new Error('getMnemonicForBackup: no vault');
  const network = await getNetwork();
  return decryptVault(blob, password, network); // throws on bad password/tamper
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
 * Preparing and committing are separate because the caller has to tear down the
 * session wallet and the Lightning swap runtime around the switch, and those are
 * both live things a user may be relying on. Doing that before the password is
 * checked would stop a running Lightning swap over nothing more than a typo. Now
 * a wrong password throws here, before the caller touches either runtime.
 *
 * Boundary: the mnemonic stays in the SW, only the password crosses in — same
 * contract as `getMnemonicForBackup`. A wrong password (or tamper) throws from
 * `decryptVault` and leaves the stored vault + network UNCHANGED (fail-closed).
 */
export async function prepareNetworkSwitch(
  newNetwork: NetworkName,
  password: string,
): Promise<{ commit: () => Promise<void> } | null> {
  const blob = await getVault();
  if (!blob) throw new Error('prepareNetworkSwitch: no vault');
  const current = await getNetwork();
  if (newNetwork === current) return null; // no-op
  // Re-auth under the CURRENT network (fail-closed: wrong password/tamper throws from decryptVault).
  const mnemonic = await decryptVault(blob, password, current);
  // Re-encrypt the SAME mnemonic under the NEW network's AAD. Nothing is stored until
  // `commit` runs, so everything above is safe to abandon.
  const newVault = await encryptVault(mnemonic, password, newNetwork);

  return {
    async commit() {
      // Flip the vault and the stored network in ONE atomic write — they must never
      // disagree, because a mismatch can't unlock.
      await setVaultAndNetwork(newVault, newNetwork);
      await clearSnapshot(); // per-network address/balance cache — drop the old one
      // We proved the password and hold the mnemonic → keep it unlocked under the new
      // network rather than forcing a re-unlock. If it was locked, stay locked.
      if (isUnlocked()) await openSession(mnemonic, newNetwork);
    },
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
  const blob = await getVault();
  if (!blob) throw new Error('unlock: no vault');
  const network = await getNetwork();
  const mnemonic = await decryptVault(blob, password, network); // throws on bad password/tamper
  if (isUnlocked()) {
    if (getSessionNetwork() !== network) {
      throw new Error('unlock: runtime and stored networks disagree');
    }
    return;
  }
  await openSession(mnemonic, network);
}
