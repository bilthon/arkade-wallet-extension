import type { NetworkName, WalletBalance } from '@arkade-os/sdk';

/**
 * Cache-first read contract (team-lead brief #3, PLAN.md §10).
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
  /** Last-known balance breakdown, or null if never fetched. */
  balance: WalletBalance | null;
  /** Epoch ms when the live operator call last succeeded. Drives staleness UI. */
  fetchedAt: number;
}

const SNAPSHOT_KEY = 'walletSnapshot';

/**
 * Read the cached snapshot for a network. Returns null if absent or if the cached
 * snapshot is for a different network (operator changed → addresses invalid).
 */
export async function getSnapshot(network: NetworkName): Promise<WalletSnapshot | null> {
  const got = await browser.storage.local.get(SNAPSHOT_KEY);
  const snap = got[SNAPSHOT_KEY] as WalletSnapshot | undefined;
  if (!snap || snap.network !== network) return null;
  return snap;
}

/** Persist a fresh snapshot (after a successful live read). */
export async function setSnapshot(snap: WalletSnapshot): Promise<void> {
  await browser.storage.local.set({ [SNAPSHOT_KEY]: snap });
}

/** Drop the snapshot (e.g. on wallet reset). */
export async function clearSnapshot(): Promise<void> {
  await browser.storage.local.remove(SNAPSHOT_KEY);
}
