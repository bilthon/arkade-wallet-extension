import { defineExtensionMessaging } from '@webext-core/messaging';
import type { NetworkName, WalletBalance } from '@arkade-os/sdk';
import type { LockState } from './keystore';
import type { WalletSnapshot } from './wallet-cache';

/**
 * Typed content <-> background protocol (PLAN.md §3, the `browser.runtime` hop).
 * `@webext-core/messaging` gives full TS inference — no stringly-typed switch.
 *
 * Two surfaces here (team-lead brief #2):
 *  • KEYSTORE ops — run entirely in the SW; the seed/mnemonic NEVER crosses this
 *    boundary except the explicit, user-initiated `getMnemonicForBackup` reveal.
 *    Everything else returns only booleans / lock state.
 *  • READ methods — addresses, balances, network. Built per-wake from the in-memory
 *    seed; only the public results cross the boundary. Cache-first: the snapshot
 *    variants return the cached value instantly, the plain variants reconcile live.
 *
 * Send/sign/approvals/delegation land in Phase 3+ (Tracks E/F) — not here.
 */
export interface ProtocolMap {
  // data: optional caller-supplied echo payload; returns pong + SW-side timestamp.
  ping(data?: { echo?: string }): { pong: true; timestamp: number; echo?: string };

  // Phase-0 G0 spike trigger — runs Wallet.create + balance + settle() in the SW
  // and returns a structured log. Exposed over messaging so it is one-command
  // triggerable from the popup / extension console (see SPIKE.md).
  runG0Spike(data?: { arkServerUrl?: string }): import('./spike').G0SpikeResult;

  // ─── Keystore (seed stays in the SW) ───────────────────────────────────────
  hasVault(): boolean;
  getLockState(): LockState;
  /** Returns the fresh mnemonic for the one-time backup flow (creation only). */
  createWallet(data: { password: string; strength?: 128 | 256 }): { mnemonic: string };
  importWallet(data: { mnemonic: string; password: string }): { ok: true };
  unlock(data: { password: string }): { ok: true };
  lock(): { ok: true };
  /** Re-auth-gated reveal — the ONLY message that returns the mnemonic post-creation. */
  getMnemonicForBackup(data: { password: string }): { mnemonic: string };

  // ─── Read methods (public results only) ────────────────────────────────────
  getAddress(): { address: string };
  getBoardingAddress(): { boardingAddress: string };
  getBalance(): WalletBalance;
  getNetwork(): { network: NetworkName };
  /**
   * Cache-first read: returns the last-known addresses + balance from storage
   * INSTANTLY (or null if never fetched / locked-and-empty). Never touches the
   * operator — safe to call while the SW is still waking. The popup renders this,
   * then calls `refreshWalletSnapshot` for live reconciliation.
   */
  getWalletSnapshot(): { snapshot: WalletSnapshot | null };
  /**
   * Live reconciliation: builds the wallet, reads addresses + balance from the
   * operator, persists the fresh snapshot, and returns it. Throws if the operator
   * is unreachable (popup keeps showing the cached snapshot + an offline banner).
   */
  refreshWalletSnapshot(): { snapshot: WalletSnapshot };
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
