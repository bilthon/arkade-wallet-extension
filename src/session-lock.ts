import { rejectPendingApproval } from './approvals';
import { clearAutoLock } from './auto-lock';
import { disposeSwaps } from './lightning';
import { emitToAllConnected } from './provider-handlers';
import { beginSessionLock } from './wallet-runtime';

export type LockReason = 'manual' | 'idle';

/**
 * Revoke every live wallet capability before starting asynchronous cleanup. Manual and
 * idle locks deliberately share this exact transition.
 */
export async function lockWallet(reason: LockReason): Promise<void> {
  const transition = beginSessionLock();
  const swapsDisposal = disposeSwaps();
  const approvalCancellation = rejectPendingApproval(
    reason === 'idle' ? 'Wallet locked after inactivity.' : 'Wallet locked by the user.',
  );
  const alarmCleanup = clearAutoLock();
  const disconnect = transition.didLock
    ? emitToAllConnected('disconnect')
    : Promise.resolve();

  await Promise.allSettled([
    transition.disposal,
    swapsDisposal,
    approvalCancellation,
    alarmCleanup,
    disconnect,
  ]);
}
