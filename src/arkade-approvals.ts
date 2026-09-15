import type { SessionContext } from './wallet-runtime';
import type { ValidatedArkadeTransaction } from './arkade-inspect';
import type { SignArkadeCheckpointsResult } from './provider-api';

export const ARKADE_APPROVAL_TTL_MS = 10 * 60_000;

/** Background-only authority; never persisted or exposed to the approval page. */
export interface ArkadeSigningApproval {
  id: string;
  origin: string;
  grantId: string;
  connectionVersion: number;
  session: SessionContext;
  transaction: ValidatedArkadeTransaction;
  operatorXOnly: string;
  expiresAt: number;
  ready: boolean;
  busy: boolean;
  completed?: { request: string[]; result: SignArkadeCheckpointsResult };
  timer?: ReturnType<typeof setTimeout>;
}

const approvals = new Map<string, ArkadeSigningApproval>();
const connections = new Map<string, { version: number; pending: number }>();

/** Persistent grant writes are asynchronous; revoke their signing authority first. */
export function beginArkadeConnectionChange(origin: string): () => void {
  const state = connections.get(origin) ?? { version: 0, pending: 0 };
  state.version++;
  state.pending++;
  connections.set(origin, state);
  invalidateArkadeApprovals(origin);
  return () => { state.pending--; };
}

export function getArkadeConnectionVersion(origin: string): number | null {
  const state = connections.get(origin);
  return state?.pending ? null : (state?.version ?? 0);
}

export function createArkadeApproval(
  binding: Pick<ArkadeSigningApproval, 'origin' | 'grantId' | 'connectionVersion' | 'session' | 'transaction' | 'operatorXOnly'>,
): ArkadeSigningApproval {
  const approval: ArkadeSigningApproval = {
    ...binding,
    id: crypto.randomUUID(),
    expiresAt: Infinity,
    ready: false,
    busy: false,
  };
  approvals.set(approval.id, approval);
  return approval;
}

/** Start the lifetime when the user approves, including time spent signing. */
export function startArkadeApprovalExpiry(approval: ArkadeSigningApproval): void {
  approval.expiresAt = Date.now() + ARKADE_APPROVAL_TTL_MS;
  approval.timer = setTimeout(() => removeArkadeApproval(approval), ARKADE_APPROVAL_TTL_MS);
}

export function getArkadeApproval(id: string): ArkadeSigningApproval | undefined {
  const approval = approvals.get(id);
  if (approval && Date.now() >= approval.expiresAt) {
    removeArkadeApproval(approval);
    return undefined;
  }
  return approval;
}

export function removeArkadeApproval(approval: ArkadeSigningApproval): void {
  if (approvals.get(approval.id) === approval) approvals.delete(approval.id);
  if (approval.timer !== undefined) clearTimeout(approval.timer);
}

/** Also cancels authorization currently being approved or signed. */
export function invalidateArkadeApprovals(origin?: string): void {
  for (const approval of approvals.values()) {
    if (origin === undefined || approval.origin === origin) removeArkadeApproval(approval);
  }
}
