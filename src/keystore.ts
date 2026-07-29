import { decryptVault, encryptVault, generateMnemonic, validateMnemonic } from './crypto';
import { getNetwork, getVault, hasVault, setVault, setVaultAndNetwork } from './storage';
import { beginSessionLock, isUnlocked, openSession } from './wallet-runtime';
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

// Observers notified AFTER the wallet locks (manual, auto, or any future path). The
// background uses this to emit a `disconnect` provider event to connected web apps so a
// lock drops their session — without the keystore importing the web app layer (one-way
// dependency: web app-handlers depends on keystore, never the reverse).
const lockListeners = new Set<() => void>();

/** Register a callback fired after each successful `lock()`. Returns an unsubscribe. */
export function onLock(listener: () => void): () => void {
  lockListeners.add(listener);
  return () => lockListeners.delete(listener);
}

const ALARM_AUTO_LOCK = 'arkade:auto-lock';
const DEFAULT_AUTO_LOCK_MINUTES = 10;

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
      if (isUnlocked()) await openRuntimeSession(mnemonic, newNetwork);
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
  await openRuntimeSession(mnemonic, network);
  return mnemonic;
}

/** Import an existing mnemonic (validated), encrypt + persist, and unlock. */
export async function importWallet(mnemonic: string, password: string): Promise<void> {
  if (await getVault()) throw new Error('importWallet: a vault already exists');
  if (!validateMnemonic(mnemonic)) throw new Error('importWallet: invalid mnemonic');
  const network = await getNetwork();
  await setVault(await encryptVault(mnemonic, password, network));
  await openRuntimeSession(mnemonic, network);
}

// ─── Lock / unlock ───────────────────────────────────────────────────────────

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
  await openRuntimeSession(mnemonic, network);
}

/**
 * Lock the runtime synchronously, then perform the listener and alarm cleanup. These
 * policy concerns remain here only until the dedicated lifecycle coordinator takes over.
 */
export async function lock(): Promise<void> {
  const transition = beginSessionLock();
  await browser.alarms.clear(ALARM_AUTO_LOCK);
  await transition.disposal;
  if (!transition.didLock) return;
  // Notify observers (the background emits `disconnect` to connected web apps). Listener
  // errors must not break the lock — swallow them.
  for (const listener of [...lockListeners]) {
    try {
      listener();
    } catch {
      /* a faulty observer must never prevent locking */
    }
  }
}

/** Install the runtime identity locally, dispose any prior wallet, and arm auto-lock. */
function openRuntimeSession(mnemonic: string, network: NetworkName): Promise<void> {
  const disposal = openSession(mnemonic, network);
  return Promise.all([disposal, armAutoLock()]).then(() => undefined);
}

// ─── Auto-lock (chrome.alarms) ───────────────────────────────────────────────

/**
 * (Re)arm the idle auto-lock alarm. Call on unlock and on each sensitive action to
 * reset the idle window. `chrome.alarms` is the only timer that survives the SW
 * being suspended; if the SW is killed first, the live identity is already gone so the
 * effect — a locked wallet — is the same.
 */
export async function armAutoLock(minutes: number = DEFAULT_AUTO_LOCK_MINUTES): Promise<void> {
  await browser.alarms.create(ALARM_AUTO_LOCK, { delayInMinutes: minutes });
}

/**
 * Register the auto-lock handler. Call once from the background entrypoint. Locks
 * the wallet when the idle alarm fires.
 */
export function registerAutoLock(): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_AUTO_LOCK) void lock();
  });
}
