import { decryptVault, encryptVault, generateMnemonic, mnemonicToSeed, validateMnemonic } from './crypto';
import { getNetwork, getVault, setUnlockFlag, setVault } from './storage';

/**
 * Lock model under MV3 (Track B, PLAN.md §7 — Strict posture).
 *
 * M1 (must-fix): the decrypted mnemonic/seed lives ONLY in this SW module-scope
 * memory. It is NEVER written to `chrome.storage.session` (which holds only the
 * unlock flag). When the SW is killed this memory is gone → the next sensitive
 * action re-prompts for the password. On manual/auto lock we zero the buffer.
 *
 * "Liveness" (VTXO renewal) does NOT need a hot key here — it uses pre-signed,
 * time-bounded intents produced while unlocked (PLAN.md §6/§7.1), so keeping the
 * seed encrypted at rest is compatible with the wallet staying fresh. This module
 * intentionally exposes no way to persist the seed.
 */

// ─── In-memory seed (M1) ─────────────────────────────────────────────────────

let unlockedSeed: Uint8Array | null = null;
// Kept alongside the seed so the build step (Track C) can re-derive the identity
// without re-decrypting. Also in memory only; cleared on lock.
let unlockedMnemonic: string | null = null;

const ALARM_AUTO_LOCK = 'arkade:auto-lock';
const DEFAULT_AUTO_LOCK_MINUTES = 10;

export function isUnlocked(): boolean {
  return unlockedSeed !== null;
}

/** The decrypted seed, or null if locked. Consumed by `buildWallet` (Track C). */
export function getUnlockedSeed(): Uint8Array | null {
  return unlockedSeed;
}

/** The decrypted mnemonic, or null if locked. Consumed by `buildWallet` (Track C). */
export function getUnlockedMnemonic(): string | null {
  return unlockedMnemonic;
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

/** Lock: zero the seed buffer, drop references, clear the flag, cancel auto-lock. */
export async function lock(): Promise<void> {
  if (unlockedSeed) unlockedSeed.fill(0);
  unlockedSeed = null;
  unlockedMnemonic = null;
  await browser.alarms.clear(ALARM_AUTO_LOCK);
  await setUnlockFlag(false);
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
 * being suspended; if the SW is killed first, the seed is already gone (M1) so the
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
