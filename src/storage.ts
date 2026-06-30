import type { NetworkName } from '@arkade-os/sdk';
import type { VaultBlob } from './crypto';

/**
 * Typed `chrome.storage` I/O (Track B, PLAN.md §10). Two areas, strict separation:
 *
 *  • local  — persistent: the encrypted vault + the active network. Survives restarts.
 *  • session — in-memory, trusted-context only: the unlock FLAG only. Under the Strict
 *              lock posture (PLAN.md §7) NOTHING secret lives here — no seed, no
 *              password, no key. After the SW dies the flag is gone and we re-prompt.
 *
 * The decrypted seed lives ONLY in SW module memory (see `keystore.ts`), never here.
 * We use `browser.storage.*` directly (not WXT's `storage` helper) to keep the
 * local/session split explicit and auditable for this security-critical layer.
 */

const VAULT_KEY = 'vault';
const NETWORK_KEY = 'network';
const UNLOCK_FLAG_KEY = 'unlocked';

/** Default dev network (PLAN.md §4: nigiri regtest is the inner-loop default). */
export const DEFAULT_NETWORK: NetworkName = 'regtest';

// ─── local (persistent) ──────────────────────────────────────────────────────

export async function getVault(): Promise<VaultBlob | null> {
  const got = await browser.storage.local.get(VAULT_KEY);
  return (got[VAULT_KEY] as VaultBlob | undefined) ?? null;
}

export async function setVault(blob: VaultBlob): Promise<void> {
  await browser.storage.local.set({ [VAULT_KEY]: blob });
}

export async function hasVault(): Promise<boolean> {
  return (await getVault()) !== null;
}

export async function getNetwork(): Promise<NetworkName> {
  const got = await browser.storage.local.get(NETWORK_KEY);
  return (got[NETWORK_KEY] as NetworkName | undefined) ?? DEFAULT_NETWORK;
}

export async function setNetwork(network: NetworkName): Promise<void> {
  await browser.storage.local.set({ [NETWORK_KEY]: network });
}

/**
 * Atomically persist a re-encrypted vault together with its active network in ONE
 * write (network switching re-binds the vault's AES-GCM AAD to the network). A single
 * `storage.local.set` is all-or-nothing: it closes the window where the vault could be
 * bound to network A while the stored network said B — a mismatch that would fail the
 * next unlock (wrong AAD) and brick the wallet until a mnemonic re-import.
 */
export async function setVaultAndNetwork(blob: VaultBlob, network: NetworkName): Promise<void> {
  await browser.storage.local.set({ [VAULT_KEY]: blob, [NETWORK_KEY]: network });
}

// ─── session (ephemeral, nothing secret) ─────────────────────────────────────

/** Set/clear the unlock flag. Strict posture: this is the ONLY thing session holds. */
export async function setUnlockFlag(unlocked: boolean): Promise<void> {
  if (unlocked) await browser.storage.session.set({ [UNLOCK_FLAG_KEY]: true });
  else await browser.storage.session.remove(UNLOCK_FLAG_KEY);
}

/**
 * Whether the SW believes itself unlocked. This is only a hint for the UI — the
 * authority is whether the in-memory seed is present (`keystore.isUnlocked()`).
 * After SW death the flag is gone, so a stale "unlocked" can't outlive the seed.
 */
export async function getUnlockFlag(): Promise<boolean> {
  const got = await browser.storage.session.get(UNLOCK_FLAG_KEY);
  return got[UNLOCK_FLAG_KEY] === true;
}
