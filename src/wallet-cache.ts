import type { NetworkName } from '@arkade-os/sdk';
import type { AdjustedBalance } from './vtxo-state';

/**
 * Cache-first read contract.
 *
 * Addresses and the last-known balance are persisted to `chrome.storage.local`,
 * keyed by network (operator-bound — a network switch yields different addresses).
 * The popup renders these INSTANTLY on open, even while the SW is still waking and
 * building the wallet. The live operator call is best-effort reconciliation that
 * overwrites the cache when it returns; the UI surfaces staleness via `fetchedAt`.
 *
 * Nothing secret lives here — only public addresses + a balance breakdown.
 */

export interface WalletSnapshot {
  network: NetworkName;
  /** Operator-bound Arkade address (`ark`/`tark…`). */
  address: string;
  /** On-chain boarding address. */
  boardingAddress: string;
  /** Last-known expiry-adjusted balance breakdown, or null if never fetched. */
  balance: AdjustedBalance | null;
  /** Epoch ms when the live operator call last succeeded. Drives staleness UI. */
  fetchedAt: number;
}

export const WALLET_SNAPSHOT_KEY = 'walletSnapshot';

/**
 * Read the cached snapshot for a network. Returns null if absent or if the cached
 * snapshot is for a different network (operator changed → addresses invalid).
 */
export async function getSnapshot(network: NetworkName): Promise<WalletSnapshot | null> {
  const got = await browser.storage.local.get(WALLET_SNAPSHOT_KEY);
  const snap = got[WALLET_SNAPSHOT_KEY] as WalletSnapshot | undefined;
  if (!snap || snap.network !== network) return null;
  return snap;
}

/** Persist a fresh snapshot (after a successful live read). */
export async function setSnapshot(snap: WalletSnapshot): Promise<void> {
  await browser.storage.local.set({ [WALLET_SNAPSHOT_KEY]: snap });
}
