/**
 * Approval-window flow (PLAN.md §7, BUILD_PLAN Phase 3 Track E).
 *
 * A web app request that needs user consent (connect / signMessage / signPsbt) does NOT resolve
 * inline. Instead:
 *   1. The background creates a pending request: a serializable record keyed by a
 *      random `requestId`, persisted to `chrome.storage.session`, plus an in-memory
 *      promise whose resolve/reject we hold.
 *   2. It opens a dedicated approval WINDOW (`chrome.windows.create`, type 'popup') at
 *      `approval.html?requestId=…`. A window — not an in-page modal — so a malicious
 *      web app can't iframe or overlay it (anti-clickjacking); the page also sets CSP
 *      `frame-ancestors 'none'`.
 *   3. The approval page reads the request (by id) — showing the SW-DERIVED origin,
 *      never a site-supplied label — waits out a settle-delay, and posts back
 *      approve/reject, which settles the original promise.
 *
 * ONE approval window at a time. A second request *from the same origin* while one is
 * pending is rejected (the web app should await the first). A request from a DIFFERENT
 * origin while a window is open is also rejected — we never stack windows.
 *
 * The promise callbacks live only in SW memory: if the SW is killed before the user
 * answers, the web app's call simply times out (provider has its own timeout). The
 * persisted record is cleaned up on resolution or when a stale window is detected.
 */

import type { PsbtSummary } from './psbt-inspect';

export type ApprovalKind = 'connect' | 'signMessage' | 'signPsbt';

/**
 * The serializable payload each approval kind shows the user. NO secrets ever cross
 * into this (it lands in `storage.session` and is read by the approval window):
 *  • connect     — nothing extra (the origin + a fixed read-method list is the whole UI).
 *  • signMessage — the exact message text the site asked us to BIP322-sign.
 *  • signPsbt    — the SW-computed PSBT summary (outputs, own-change, fee, which inputs
 *                  we sign, danger flags, contract co-sign details). NEVER a site-supplied
 *                  summary — this is the inspector's output, computed in the SW.
 */
export type ApprovalPayload =
  | { kind: 'connect' }
  | { kind: 'signMessage'; message: string }
  | { kind: 'signPsbt'; summary: PsbtSummary };

/** Serializable request the approval window reads (NO secrets, NO promise callbacks). */
export interface PendingRequest {
  requestId: string;
  kind: ApprovalKind;
  /** SW-derived origin (origin.ts). The approval UI shows THIS, verbatim. */
  origin: string;
  createdAt: number;
  /** Kind-specific render data (the message / the PSBT summary). */
  payload: ApprovalPayload;
}

export interface ApprovalDecision {
  approved: boolean;
}

const PENDING_KEY = 'pendingApproval';

/** A typed error a web app handler can surface when a request can't be queued. */
export class ApprovalError extends Error {
  constructor(
    readonly code: 'BUSY' | 'NO_REQUEST' | 'WINDOW_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

// In-memory promise resolvers for the single in-flight request. NOT persisted — they
// can't be; they're closures. Mirrors the persisted record's lifetime within one SW life.
interface InFlight {
  request: PendingRequest;
  windowId: number | null;
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
}

let inFlight: InFlight | null = null;

function randomId(): string {
  // crypto.randomUUID is available in the SW (and the test env via node:crypto webcrypto).
  return crypto.randomUUID();
}

async function persist(request: PendingRequest | null): Promise<void> {
  if (request) await browser.storage.session.set({ [PENDING_KEY]: request });
  else await browser.storage.session.remove(PENDING_KEY);
}

/**
 * The pending request the approval window reads by id. Returns null if there is none,
 * or if the id doesn't match the in-flight one (stale/closed window). The window only
 * ever learns the SW-derived origin through this — it cannot be told a different label.
 */
export async function getPendingRequest(requestId: string): Promise<PendingRequest | null> {
  const got = await browser.storage.session.get(PENDING_KEY);
  const rec = got[PENDING_KEY] as PendingRequest | undefined;
  if (!rec || rec.requestId !== requestId) return null;
  return rec;
}

/**
 * Open an approval window for `payload` from `origin` and return a promise that settles
 * when the user (or a revocation) resolves it. `openWindow` is injected so tests can
 * drive resolution without a real `chrome.windows.create`; in the background it is the
 * real window-create call. The `kind` is taken from the payload so the two never drift.
 *
 * Throws `ApprovalError('BUSY')` if a request is already in flight (one window at a time).
 */
export async function requestApproval(
  payload: ApprovalPayload,
  origin: string,
  openWindow: (request: PendingRequest) => Promise<number | null>,
): Promise<ApprovalDecision> {
  if (inFlight) {
    throw new ApprovalError(
      'BUSY',
      'Another approval is already open. Finish it before making a new request.',
    );
  }

  const request: PendingRequest = {
    requestId: randomId(),
    kind: payload.kind,
    origin,
    createdAt: Date.now(),
    payload,
  };

  // Establish the in-flight record BEFORE opening the window so a fast approve can't race
  // a null `inFlight`. Persist the serializable half for the window to read.
  let record!: InFlight;
  const decision = new Promise<ApprovalDecision>((resolve, reject) => {
    record = { request, windowId: null, resolve, reject };
    inFlight = record;
  });
  await persist(request);

  let windowId: number | null;
  try {
    windowId = await openWindow(request);
  } catch (err) {
    await clearInFlight();
    throw new ApprovalError(
      'WINDOW_FAILED',
      `Could not open the approval window: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Record the window id on the request we created. If a fast approve/close during
  // `openWindow` already cleared `inFlight`, writing to the (now-orphaned) record is
  // harmless — the resolve/reject already fired and nothing else reads it.
  record.windowId = windowId;

  return decision;
}

/**
 * Resolve the in-flight request with the user's decision (called by the
 * `approvalResponse` handler from the approval window). Returns false if the id doesn't
 * match the current in-flight request (stale window / already resolved).
 */
export async function resolveApproval(
  requestId: string,
  decision: ApprovalDecision,
): Promise<boolean> {
  if (!inFlight || inFlight.request.requestId !== requestId) return false;
  const { resolve } = inFlight;
  await clearInFlight();
  resolve(decision);
  return true;
}

/**
 * Reject the in-flight request from a given origin (used by `disconnect`/revoke: a
 * revocation must reject any pending request from that same origin). No-op if nothing
 * is in flight or the origin doesn't match.
 */
export async function rejectApprovalForOrigin(origin: string, reason: string): Promise<boolean> {
  if (!inFlight || inFlight.request.origin !== origin) return false;
  const { reject } = inFlight;
  await clearInFlight();
  reject(new ApprovalError('NO_REQUEST', reason));
  return true;
}

/** The origin/window of the current in-flight request, or null. */
export function currentInFlight(): { origin: string; windowId: number | null } | null {
  if (!inFlight) return null;
  return { origin: inFlight.request.origin, windowId: inFlight.windowId };
}

/** Clear in-flight state + the persisted record. Internal; also used on stale cleanup. */
async function clearInFlight(): Promise<void> {
  inFlight = null;
  await persist(null);
}

/**
 * Handle the approval window being closed without a decision (the user dismissed it):
 * reject the in-flight request so the web app's promise doesn't hang. Called from the
 * background's `windows.onRemoved` listener with the closed window id.
 */
export async function onWindowClosed(windowId: number): Promise<void> {
  if (!inFlight || inFlight.windowId !== windowId) return;
  const { reject } = inFlight;
  await clearInFlight();
  reject(new ApprovalError('NO_REQUEST', 'Approval window was closed.'));
}
