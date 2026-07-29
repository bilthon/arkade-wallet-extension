import { rejectPendingApproval } from './approvals';
import { armAutoLock, clearAutoLock } from './auto-lock';
import { prepareNetworkSwitch, type PreparedNetworkSwitch } from './keystore';
import { disposeSwaps } from './lightning';
import { emitToAllConnected } from './provider-handlers';
import { lockWallet } from './session-lock';
import { setVaultAndNetwork } from './storage';
import { beginRuntimeNetworkSwitch } from './wallet-runtime';
import type { NetworkName } from '@arkade-os/sdk';

let transitionTail: Promise<void> = Promise.resolve();

/**
 * Authenticate and stage a network switch, then serialize its destructive transition.
 * Returns `false` for a same-network no-op and `true` after a durable change.
 */
export function switchWalletNetwork(
  targetNetwork: NetworkName,
  password: string,
): Promise<boolean> {
  const result = transitionTail.then(
    () => prepareAndCommit(targetNetwork, password),
    () => prepareAndCommit(targetNetwork, password),
  );
  transitionTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function prepareAndCommit(
  targetNetwork: NetworkName,
  password: string,
): Promise<boolean> {
  const prepared = await prepareNetworkSwitch(targetNetwork, password);
  if (!prepared) return false;
  await commitPreparedSwitch(prepared);
  return true;
}

async function commitPreparedSwitch(prepared: PreparedNetworkSwitch): Promise<void> {
  // This check and fence are synchronous. Anything holding the old context loses its
  // authority before storage, disposal, alarm, or provider cleanup can await.
  const transition = beginRuntimeNetworkSwitch(prepared.runtime);
  const cleanup = Promise.allSettled([
    transition.disposal,
    disposeSwaps(),
    rejectPendingApproval('Wallet network changed.'),
    clearAutoLock(),
  ]);

  try {
    await setVaultAndNetwork(prepared.vault, prepared.targetNetwork);
  } catch (err) {
    await cleanup;
    if (transition.hadSession) await emitSafely('disconnect');
    transition.abort();
    throw err;
  }

  let installed = false;
  let installError: unknown;
  try {
    installed = transition.install();
  } catch (err) {
    installError = err;
  }

  if (installError) {
    transition.abort();
    const failClosed = lockWallet('idle');
    await cleanup;
    await failClosed;
    await emitSafely('networkChanged', { network: prepared.targetNetwork });
    throw installError;
  }

  if (installed) {
    try {
      await armAutoLock();
    } catch (err) {
      await lockWallet('idle');
      await cleanup;
      await emitSafely('networkChanged', { network: prepared.targetNetwork });
      throw err;
    }
  }

  await cleanup;

  await emitSafely('networkChanged', { network: prepared.targetNetwork });
}

async function emitSafely(
  event: 'networkChanged' | 'disconnect',
  data?: unknown,
): Promise<void> {
  await emitToAllConnected(event, data).catch(() => {});
}
