import { ArkAddress, RestDelegateProvider, type DelegateProvider, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import type { DelegationConfig } from './delegation-state';

/** Sanity-check delegate metadata against this network/operator, even at zero fee. */
export function validateDelegateAddress(config: DelegationConfig, wallet: Wallet): void {
  const address = ArkAddress.decode(config.delegate.delegateAddress);
  const operator = wallet.arkServerPublicKey;
  const operatorHex = hex.encode(operator.length === 33 ? operator.slice(1) : operator);
  if (address.hrp !== wallet.network.hrp || hex.encode(address.serverPubKey) !== operatorHex) {
    throw new Error('Delegate address belongs to a different network or operator.');
  }
}

/**
 * Wallet construction needs metadata, even when paused or offline. Submission needs
 * fresh authorization instead. Never replace the approved key with a newly fetched key.
 */
export function createSessionDelegate(
  config: DelegationConfig,
  assertCurrent: () => void,
  remote: DelegateProvider = new RestDelegateProvider(config.delegate.url),
) {
  const approved = { ...config.delegate };
  const enabled = config.enabled;

  async function assertDelegationAllowed(): Promise<void> {
    assertCurrent();
    if (!enabled) throw new Error('Delegation is paused.');
    const live = await remote.getDelegateInfo();
    assertCurrent();
    if (live.pubkey.toLowerCase() !== approved.pubkey.toLowerCase()
      || live.delegateAddress !== approved.delegateAddress) {
      throw new Error('Delegate identity changed. Approve the delegate again.');
    }
    if (live.fee !== '0') throw new Error('Only zero-fee delegation is supported.');
  }

  const provider: DelegateProvider = {
    getDelegateInfo: async () => ({
      pubkey: approved.pubkey, delegateAddress: approved.delegateAddress, fee: approved.fee,
    }),
    delegate: async (...args) => {
      // Recheck after SDK signing, immediately before publishing the authorization.
      await assertDelegationAllowed();
      assertCurrent();
      return remote.delegate(...args);
    },
  };

  return { provider, assertDelegationAllowed };
}

/** Reject paused/stale delegation before the SDK constructs and signs any proofs. */
export async function guardDelegateManager(wallet: Wallet, assertDelegationAllowed: () => Promise<void>): Promise<void> {
  const manager = await wallet.getDelegateManager();
  if (!manager) return;
  const delegate = manager.delegate.bind(manager);
  manager.delegate = async (...args) => {
    await assertDelegationAllowed();
    return delegate(...args);
  };
}
