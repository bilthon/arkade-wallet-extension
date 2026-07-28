import { decryptVault, encryptVault, generateMnemonic, mnemonicToSeed, validateMnemonic } from './crypto';
import { getNetwork, getVault, hasVault, setUnlockFlag, setVault, setVaultAndNetwork } from './storage';
import { clearSnapshot } from './wallet-cache';
import type { NetworkName } from '@arkade-os/sdk';

/**
 * Lock model under MV3 (Strict posture).
 *
 * The decrypted mnemonic/seed lives ONLY in this SW module-scope memory. It is
 * NEVER written to `chrome.storage.session` (which holds only the unlock flag).
 * When the SW is killed this memory is gone → the next sensitive action re-prompts
 * for the password. On manual/auto lock we zero the buffer.
 *
 * "Liveness" (VTXO renewal) does NOT need a hot key here — it uses pre-signed,
 * time-bounded intents produced while unlocked, so keeping the seed encrypted at
 * rest is compatible with the wallet staying fresh. This module intentionally
 * exposes no way to persist the seed.
 */

// ─── In-memory seed ──────────────────────────────────────────────────────────

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

let unlockedSeed: Uint8Array | null = null;
// Kept alongside the seed so the build step can re-derive the identity
// without re-decrypting. Also in memory only; cleared on lock.
let unlockedMnemonic: string | null = null;

const ALARM_AUTO_LOCK = 'arkade:auto-lock';
const DEFAULT_AUTO_LOCK_MINUTES = 10;

export function isUnlocked(): boolean {
  return unlockedSeed !== null;
}

/** The decrypted seed, or null if locked. Consumed by `buildWallet`. */
export function getUnlockedSeed(): Uint8Array | null {
  return unlockedSeed;
}

/** The decrypted mnemonic, or null if locked. Consumed by `buildWallet`. */
export function getUnlockedMnemonic(): string | null {
  return unlockedMnemonic;
}

/**
 * Lock state for the popup router. `hasVault` decides welcome-vs-unlock; `unlocked`
 * is the AUTHORITY (the in-memory seed), not the session flag — after an SW kill the
 * seed is gone so this correctly reports locked even if a stale flag lingered.
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
 * This is the ONLY path by which the mnemonic crosses the SW boundary, and only on
 * an explicit, user-initiated request.
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
      if (isUnlocked()) await holdUnlocked(mnemonic);
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
  await holdUnlocked(mnemonic);
  return mnemonic;
}

/** Import an existing mnemonic (validated), encrypt + persist, and unlock. */
export async function importWallet(mnemonic: string, password: string): Promise<void> {
  if (await getVault()) throw new Error('importWallet: a vault already exists');
  if (!validateMnemonic(mnemonic)) throw new Error('importWallet: invalid mnemonic');
  const network = await getNetwork();
  await setVault(await encryptVault(mnemonic, password, network));
  await holdUnlocked(mnemonic);
}

// ─── Lock / unlock ───────────────────────────────────────────────────────────

/**
 * Unlock by decrypting the stored vault. A wrong password (or a tampered vault)
 * throws from `decryptVault` and the wallet stays locked — we never set the seed
 * on a failed auth. On success the seed is held in memory and the auto-lock timer
 * (re)starts.
 */
export async function unlock(password: string): Promise<void> {
  const blob = await getVault();
  if (!blob) throw new Error('unlock: no vault');
  const network = await getNetwork();
  const mnemonic = await decryptVault(blob, password, network); // throws on bad password/tamper
  await holdUnlocked(mnemonic);
}

/**
 * Lock: zero the seed *buffer*, drop references, clear the flag, cancel auto-lock.
 * Note: only the seed `Uint8Array` is scrubbed in place. The mnemonic is a JS string
 * (immutable, un-zeroable) — dropping the reference makes it GC-reachable but it may
 * linger in memory until collected. Don't assume the mnemonic is wiped synchronously.
 */
export async function lock(): Promise<void> {
  if (unlockedSeed) unlockedSeed.fill(0);
  unlockedSeed = null;
  unlockedMnemonic = null;
  await browser.alarms.clear(ALARM_AUTO_LOCK);
  await setUnlockFlag(false);
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

/** Derive + hold the seed in memory and arm auto-lock. Internal to unlock paths. */
async function holdUnlocked(mnemonic: string): Promise<void> {
  unlockedMnemonic = mnemonic;
  unlockedSeed = mnemonicToSeed(mnemonic);
  await setUnlockFlag(true);
  await armAutoLock();
}

// ─── Auto-lock (chrome.alarms) ───────────────────────────────────────────────

/**
 * (Re)arm the idle auto-lock alarm. Call on unlock and on each sensitive action to
 * reset the idle window. `chrome.alarms` is the only timer that survives the SW
 * being suspended; if the SW is killed first, the seed is already gone so the
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
