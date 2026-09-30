import { ArkAddress, type DelegateProvider, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { createDelegateTransport } from './delegation-transport';
import { DelegationPolicyError } from './delegation-policy';
import type { DelegationConfig } from './delegation-state';

/**
 * Connect the SDK's delegation flow to the user's approval for this wallet session.
 * The SDK constructs and signs authorizations; this module checks whether they may
 * be sent, and delegation-transport.ts handles the HTTP requests to Fulmine.
 * Both layers implement DelegateProvider, but only the checked provider goes to the
 * SDK: SDK -> checked provider -> HTTP transport -> Fulmine.
 *
 * SDK metadata reads use the saved approval so the wallet keeps the same receiving
 * script even when Fulmine is offline. Authorization checks fetch live metadata to
 * detect changed terms. Submission tracking calls our check before SDK signing;
 * the checked provider repeats it after signing, before publishing the authorization.
 * Policy mismatches block this session and notify the runtime to persist a pause.
 * Submission outcomes and retries are handled by delegation-submissions.ts.
 */

/** Sanity-check delegate metadata against this network/operator, even at zero fee. */
export function validateDelegateAddress(config: DelegationConfig, wallet: Wallet): void {
  const address = ArkAddress.decode(config.delegate.delegateAddress);
  const operator = wallet.arkServerPublicKey;
  const operatorHex = hex.encode(operator.length === 33 ? operator.slice(1) : operator);
  if (address.hrp !== wallet.network.hrp || hex.encode(address.serverPubKey) !== operatorHex) {
    throw new Error('Delegate address belongs to a different network or operator.');
  }
}

interface DelegationChecks {
  assertOperatorAllowed?: () => Promise<void>;
  validateIntent?: (intent: Parameters<DelegateProvider['delegate']>[0]) => Promise<void>;
  onPolicyMismatch?: () => void;
}

/** The SDK provider and authorization checks bound to one wallet session. */
interface SessionDelegate {
  provider: DelegateProvider;
  assertDelegationAllowed: () => Promise<void>;
  assertSettlementAllowed: () => Promise<void>;
}

/**
 * Build the checked provider and authorization callbacks for one wallet session.
 * Capture the saved approval here: a later configuration change creates a new session.
 * Metadata reads return that approval; live checks compare against it, never silently
 * replace it with whatever Fulmine currently reports.
 */
export function createSessionDelegate(
  config: DelegationConfig,
  assertCurrent: () => void,
  transport: DelegateProvider = createDelegateTransport(config.delegate.url),
  checks: DelegationChecks = {},
): SessionDelegate {
  const approvedDelegate = { ...config.delegate };
  const enabled = config.enabled;
  let blockingPolicyError: DelegationPolicyError | undefined;

  /**
   * Remember the first policy mismatch and ask the runtime to persist a pause once.
   * Keep blocking work even if the remote terms later change back. Connection errors
   * do not go through this function, so a temporary outage can be retried.
   */
  function rejectPolicy(error: DelegationPolicyError): never {
    if (!blockingPolicyError) {
      blockingPolicyError = error;
      checks.onPolicyMismatch?.();
    }
    throw error;
  }

  /**
   * Check whether online onboarding or renewal may proceed. Check the session,
   * enabled state, and operator fee policy without contacting Fulmine, so a delegate
   * outage alone does not prevent the wallet from settling its own funds.
   */
  async function assertSettlementAllowed(): Promise<void> {
    assertCurrent();
    if (!enabled) throw new Error('Delegation is paused.');
    if (blockingPolicyError) throw blockingPolicyError;
    try {
      await checks.assertOperatorAllowed?.();
    } catch (error) {
      if (error instanceof DelegationPolicyError) rejectPolicy(error);
      throw error;
    }
    // Another operation may have locked the wallet or detected a mismatch while
    // this one awaited operator information.
    assertCurrent();
    if (blockingPolicyError) throw blockingPolicyError;
  }

  /**
   * Before authorizing delegation, check Fulmine's live key, fee address, and fee
   * against our approval and zero-fee policy. Also apply the operator/session checks
   * used for online settlement. An unavailable delegate causes a retryable failure.
   */
  async function assertDelegationAllowed(): Promise<void> {
    assertCurrent();
    if (!enabled) throw new Error('Delegation is paused.');
    if (blockingPolicyError) throw blockingPolicyError;
    const live = await transport.getDelegateInfo();
    assertCurrent();
    if (live.pubkey.toLowerCase() !== approvedDelegate.pubkey.toLowerCase()
      || live.delegateAddress !== approvedDelegate.delegateAddress) {
      rejectPolicy(new DelegationPolicyError('Delegate identity changed. Approve the delegate again.'));
    }
    if (live.fee !== '0') rejectPolicy(new DelegationPolicyError('Only zero-fee delegation is supported.'));
    await assertSettlementAllowed();
  }

  /**
   * The SDK calls this with already-signed authorizations. Recheck live approval and
   * inspect the signed intent before passing anything to the HTTP transport. Check
   * the session again after validation so a lock during that wait prevents sending.
   */
  async function submitCheckedDelegation(...args: Parameters<DelegateProvider['delegate']>): Promise<void> {
    await assertDelegationAllowed();
    try {
      await checks.validateIntent?.(args[0]);
    } catch (error) {
      if (error instanceof DelegationPolicyError) rejectPolicy(error);
      throw error;
    }
    assertCurrent();
    if (blockingPolicyError) throw blockingPolicyError;
    return transport.delegate(...args);
  }

  const checkedProvider: DelegateProvider = {
    // Return a fresh copy of approved metadata, without requiring an HTTP request.
    getDelegateInfo: async () => ({
      pubkey: approvedDelegate.pubkey,
      delegateAddress: approvedDelegate.delegateAddress,
      fee: approvedDelegate.fee,
    }),
    delegate: submitCheckedDelegation,
  };

  return { provider: checkedProvider, assertDelegationAllowed, assertSettlementAllowed };
}
