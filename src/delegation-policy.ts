import { ArkAddress, Intent, type IntentFeeConfig, type SignedIntent, type Wallet } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { parsePsbt } from './psbt-inspect';
import type { ApprovedDelegate } from './delegation-state';

/**
 * Define the wallet's current zero-cost rules for automatic work. These checks sit
 * at two boundaries: operator fee approval before enabling or performing automatic
 * work, and inspection of the signed delegation intent before sending it to Fulmine.
 *
 * The SDK constructs the transactions. This module checks our allowed terms; the
 * session provider decides when to run the checks and how to pause on a violation.
 * Paid delegation would require changing these policies, not just the transport.
 */

/** Policy changes require approval again; connectivity failures merely need a retry. */
export class DelegationPolicyError extends Error {}

/**
 * Require every advertised intent fee to be unconditionally zero. An authorization
 * may execute later, so a formula that is free now could charge at renewal time.
 * We deliberately reject formulas rather than evaluate them at approval time.
 */
export function assertZeroIntentFees(fees: IntentFeeConfig): void {
  for (const expression of [fees.onchainInput, fees.offchainInput, fees.onchainOutput, fees.offchainOutput]) {
    // Missing/empty fees and literal zeros such as "0", "0.00", and "+0" are allowed.
    // Check the text rather than converting to Number: "1e-999" would round to zero,
    // and expressions such as "0 * x" are outside the policy we currently support.
    if (expression !== undefined && expression.trim() !== ''
      && !/^[+-]?0+(?:\.0+)?$/.test(expression.trim())) {
      throw new DelegationPolicyError('Automatic delegation requires zero operator fees.');
    }
  }
}

/**
 * Fetch the operator's current fee policy for approval or automatic work. The wallet
 * may lock while the request is pending, so check the session before evaluating it.
 */
export async function assertOperatorFeesZero(wallet: Pick<Wallet, 'arkProvider'>, assertCurrent: () => void): Promise<void> {
  const info = await wallet.arkProvider.getInfo();
  assertCurrent();
  assertZeroIntentFees(info.fees.intentFee);
}

/**
 * Inspect the authorization the SDK has signed before the provider sends it to
 * Fulmine. Require the approved delegate, one positive output back to this wallet,
 * and no value left as an operator fee. A separate delegate-payment output is not
 * allowed by this version's zero-cost policy.
 *
 * This checks authorization terms, not cryptographic signatures. It also cannot
 * guarantee that Fulmine will execute the renewal after accepting the task.
 */
export function validateDelegationIntent(
  intent: SignedIntent<Intent.RegisterMessage>,
  approved: ApprovedDelegate,
  destination: string,
): void {
  const message = intent.message;
  const proof = parsePsbt(intent.proof);
  // Register an off-chain settlement with exactly the delegate the user approved.
  const hasApprovedTerms = message.type === 'register'
    && message.onchain_output_indexes.length === 0
    && message.cosigners_public_keys.length === 1
    && message.cosigners_public_keys[0].toLowerCase() === approved.pubkey.toLowerCase();
  if (!hasApprovedTerms) {
    throw new DelegationPolicyError('Delegation intent does not match the approved terms.');
  }

  // Compare the actual output script with our destination, and require a positive
  // amount. Selecting an output only when there is exactly one also excludes splits.
  const expectedScript = ArkAddress.decode(destination).pkScript;
  const output = proof.outputsLength === 1 ? proof.getOutput(0) : undefined;
  const returnsToWallet = output?.script !== undefined
    && output.amount !== undefined && output.amount > 0n
    && hex.encode(output.script) === hex.encode(expectedScript);
  if (!returnsToWallet) {
    throw new DelegationPolicyError('Delegation must return funds to this wallet.');
  }

  // Use the SDK's intent fee calculation so its synthetic proof input is handled
  // correctly. Zero fee plus the single wallet output means all value returns to us.
  if (Intent.fee(proof) !== 0) {
    throw new DelegationPolicyError('Delegation must not charge operator fees.');
  }
}
