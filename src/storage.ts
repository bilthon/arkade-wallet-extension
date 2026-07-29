import type { NetworkName } from '@arkade-os/sdk';
import type { VaultBlob } from './crypto';

/**
 * Typed persistent `chrome.storage.local` I/O:
 *
 *  • the encrypted mnemonic vault and active network survive restarts;
 *  • live identity and unlock state exist only in `wallet-runtime.ts` memory.
 *
 * Other modules use `storage.session` for non-secret ephemeral state such as pending
 * approvals. This storage layer does not persist an unlock hint or any key material.
 * We use `browser.storage.*` directly (not WXT's `storage` helper) to keep the
 * local/session split explicit and auditable for this security-critical layer.
 */

const VAULT_KEY = 'vault';
const NETWORK_KEY = 'network';

/** Default dev network: nigiri regtest is the inner-loop default. */
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
