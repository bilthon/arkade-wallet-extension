import { RestDelegateProvider } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { rejectPendingApproval } from './approvals';
import { getDelegationConfig, setDelegationConfig, type DelegationConfig } from './delegation-state';
import { createSessionDelegate, validateDelegateAddress } from './delegation-provider';
import { disposeSwaps } from './lightning';
import { lockWallet } from './session-lock';
import { networkConfig } from './wallet';
import { WALLET_SNAPSHOT_KEY } from './wallet-cache';
import { beginRuntimeWalletRebuild, getSessionContext, type SessionContext } from './wallet-runtime';

let configurationChange: Promise<void> = Promise.resolve();

/**
 * Serialize approval changes. A request keeps its original context while queued, so
 * two competing changes cannot silently overwrite one another's approval snapshot.
 */
export function configureDelegation(context: SessionContext, config: DelegationConfig): Promise<void> {
  const requested = structuredClone(config);
  const result = configurationChange.then(() => applyConfiguration(context, requested));
  configurationChange = result.catch(() => {});
  return result;
}

async function applyConfiguration(context: SessionContext, config: DelegationConfig): Promise<void> {
  context.assertCurrent();
  if (context.network !== 'regtest') throw new Error('Delegation is available on regtest only.');
  const network = networkConfig(context.network);
  const scope = {
    walletPublicKey: hex.encode(await context.wallet.identity.xOnlyPublicKey()),
    network: context.network,
    operatorUrl: network.arkServerUrl,
  };
  context.assertCurrent();
  validateDelegateAddress(config, context.wallet);
  if (config.enabled) {
    if (config.delegate.url !== network.delegateUrl) throw new Error('Unexpected delegate endpoint.');
    const remote = new RestDelegateProvider(config.delegate.url);
    await createSessionDelegate(config, context.assertCurrent, remote).assertDelegationAllowed();
  } else {
    // Pause preserves the approved script; it is not a way to approve another key offline.
    const previous = await getDelegationConfig(scope);
    const approved = previous?.delegate;
    const requested = config.delegate;
    if (!approved || approved.url !== requested.url || approved.pubkey !== requested.pubkey
      || approved.delegateAddress !== requested.delegateAddress || approved.fee !== requested.fee) {
      throw new Error('Approve the delegate before pausing delegation.');
    }
  }
  context.assertCurrent();
  const transition = beginRuntimeWalletRebuild(context);
  try {
    await Promise.allSettled([
      transition.disposal,
      disposeSwaps(),
      rejectPendingApproval('Wallet delegation configuration changed.'),
    ]);
    await browser.storage.local.remove(WALLET_SNAPSHOT_KEY);
    await setDelegationConfig(scope, config);
    if (!transition.install()) throw new Error('LOCKED');
  } catch (error) {
    // A failed write or a lock during transition must never resurrect the old session.
    // Lock while the transition still exists so it can emit its disconnect once.
    // A concurrent lock has already cancelled it and will not emit a second time.
    const cleanup = lockWallet('idle');
    transition.abort();
    await cleanup;
    throw error;
  }
  // Construct the wallet with the approved receiving script; the next snapshot read
  // refreshes addresses and balances. A build failure leaves this session retryable.
  await getSessionContext();
}
