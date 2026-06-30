import { defineExtensionMessaging } from '@webext-core/messaging';
import type { NetworkName } from '@arkade-os/sdk';
import type { LockState } from './keystore';
import type { WalletSnapshot } from './wallet-cache';
import type { AdjustedBalance } from './vtxo-state';
import type { RenewalWarning } from './renewal';
import type { Grant } from './permissions';
import type { PendingRequest } from './approvals';
import type { NetworkInfo, PublicKeyInfo } from './provider-api';

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
  /** Re-encrypt the vault under a new network's AAD (requires the password). */
  switchNetwork(data: { network: NetworkName; password: string }): { ok: true };

  // ─── Read methods (public results only) ────────────────────────────────────
  getAddress(): { address: string };
  getBoardingAddress(): { boardingAddress: string };
  /** Expiry-adjusted balance: expired-but-unswept VTXOs are pulled out of
   *  `available` into the `expired` bucket (Track F bug fix). */
  getBalance(): AdjustedBalance;
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

  // ─── Off-chain send (Track E — the first write/spend path) ─────────────────
  /**
   * In-wallet off-chain Arkade→Arkade send. Gated on unlock (`requireWallet`).
   * The SW validates the address (well-formed Arkade address for the ACTIVE
   * network — rejects on-chain/malformed/cross-network) and the amount (integer,
   * > 0, ≥ dust, ≤ live available balance) BEFORE signing, then calls the SDK's
   * `send`. The seed never crosses this boundary. Returns the txid.
   * Validation failures surface as an Error whose serialized `.message` is the
   * user-facing string the popup renders (the `SendValidationError` class/`code`
   * live SW-side; only the message survives the message boundary).
   */
  send(data: { address: string; amount: number }): { txid: string };

  // ─── Renewal + recovery + onboarding (Track F — deliberate, unlock-gated) ───
  /**
   * Explicitly renew every still-VALID VTXO within the safety margin of its batch
   * expiry (expiring-soon but not yet expired/swept). Unlock-gated (throws 'LOCKED'
   * when locked — renewal signs). Returns how many coins were renewed and the
   * commitment txid (absent when nothing was due). Already-expired/swept coins are
   * NOT renewed here — they go through `recoverNow`.
   */
  renewNow(): { renewed: number; txid?: string };
  /**
   * Explicitly recover swept / already-expired ("recoverable") VTXOs — the operator
   * re-issues them in a fresh batch back to the user's own address. Distinct round
   * from renewal (`recoverVtxos`). Unlock-gated. Returns how many coins were recovered,
   * their sats, and the commitment txid (absent when nothing was recoverable).
   */
  recoverNow(): { recovered: number; sats: number; txid?: string };
  /**
   * Explicitly onboard confirmed boarding UTXOs into VTXOs (Boarding → spendable).
   * Unlock-gated. Returns whether anything was onboarded + the commitment txid.
   */
  onboardNow(): { onboarded: boolean; txid?: string };
  /**
   * The latest expiry/renewal warning (counts + soonest expiry), or null. Read by
   * the popup to drive the "needs renewal — unlock to renew" / countdown UI. No
   * secrets — just figures. Safe to call while locked.
   */
  getRenewalWarning(): { warning: RenewalWarning | null };

  // ─── Provider surface (Track E2a — origin + grant gated) ───────────────────
  //
  // These are the ONLY messages the ISOLATED content bridge forwards on a web
  // app's behalf. The background derives the origin from `sender` (NEVER a body
  // field), checks the per-origin grant, and returns public results only. They are
  // distinct from the popup read methods above so the trusted popup path is never
  // confused with the untrusted provider path. `connect` prompts via the approval
  // window; the rest read the existing grant + require the wallet unlocked (typed
  // LOCKED/NOT_CONNECTED).
  //
  // providerConnect carries no params — the origin is the sender's, resolved SW-side.
  providerConnect(): { accounts: string[] };
  providerDisconnect(): { ok: true };
  providerIsConnected(): { connected: boolean };
  providerGetAccounts(): { accounts: string[] };
  providerGetAddress(): { address: string };
  providerGetBoardingAddress(): { boardingAddress: string };
  providerGetPublicKey(): PublicKeyInfo;
  providerGetBalance(): AdjustedBalance;
  providerGetNetwork(): NetworkInfo;
  // Signing — each re-prompts via the approval window (NOT granted by connect). The SW
  // validates everything itself; the seed never crosses this boundary, only the signature
  // / signed PSBT does. `signPsbt` returns the PSBT UNFINALIZED (others co-sign after us).
  providerSignMessage(data: { message: string }): { signature: string };
  providerSignPsbt(data: {
    psbt: string;
    inputIndexes: number[];
    allowHighFee?: boolean;
  }): { psbt: string };

  // ─── Approval window ↔ background (trusted extension page) ──────────────────
  /** The approval window reads its request by id (shows the SW-derived origin). */
  getApprovalRequest(data: { requestId: string }): { request: PendingRequest | null };
  /** The approval window posts the user's decision; resolves the web app's promise. */
  approvalResponse(data: { requestId: string; approved: boolean }): { ok: true };

  // ─── Connected-sites management (popup Settings — trusted) ──────────────────
  /** Every active grant, for the Connected-sites screen. */
  listConnectedSites(): { grants: Grant[] };
  /** Revoke a site's grant: immediate, rejects any pending request + emits disconnect. */
  revokeConnectedSite(data: { origin: string }): { ok: true };
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
