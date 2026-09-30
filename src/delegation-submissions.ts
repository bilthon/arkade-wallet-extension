import type { ContractVtxo, IDelegateManager, Outpoint } from '@arkade-os/sdk';
import { DelegationPolicyError } from './delegation-policy';
import {
  getDelegationSubmissions,
  setDelegationSubmission,
  type ApprovedDelegate,
  type DelegationScope,
  type DelegationSubmission,
} from './delegation-state';

interface DelegationTrackingOptions {
  scope: DelegationScope;
  delegate: ApprovedDelegate;
  assertCurrent: () => void;
  assertDelegationAllowed: () => Promise<void>;
  /** Verified ordinary wallet contracts for the approved delegate, encoded as hex. */
  eligibleScripts: () => Promise<Set<string>>;
}

export interface DelegationSubmissions {
  /**
   * Serialize settlement with delegation so neither spends a coin being authorized.
   * The callback must not call manager.delegate(), which already uses this queue.
   */
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Include remote acceptance awaiting persistence; this lookup never signs or writes. */
  acceptedOutpoints: (outpoints: string[], destination: string) => Promise<Set<string>>;
}

const SUBMISSION_FAILED = 'Delegation was not confirmed. The wallet will retry while unlocked.';
const POLICY_FAILED = 'Delegation is paused because the approved policy changed. Approve delegation again to continue.';
const RETRY_DELAY_MS = 60_000;

/** Accepted submissions are those that have been confirmed by Fulmine. */
type AcceptedSubmission = Extract<DelegationSubmission, { status: 'delegated' }>;

interface SubmissionSelection {
  eligible: ContractVtxo[];
  pending: ContractVtxo[];
  savedRecords: Map<string, DelegationSubmission>;
  // Include acceptances held in memory even if their storage write failed.
  records: Map<string, DelegationSubmission>;
}

/** Keep policy failures actionable without exposing the SDK's error or signed payloads. */
function safeSubmissionError(error: unknown): Error {
  return error instanceof DelegationPolicyError
    ? new DelegationPolicyError(POLICY_FAILED)
    : new Error(SUBMISSION_FAILED);
}

/** Check whether storage already contains this exact acceptance, avoiding repeat writes. */
function isAcceptanceSaved(saved: DelegationSubmission | undefined, accepted: AcceptedSubmission): boolean {
  return saved?.status === 'delegated' && saved.delegateUrl === accepted.delegateUrl
    && saved.delegatePubkey === accepted.delegatePubkey && saved.destination === accepted.destination
    && saved.submittedAt === accepted.submittedAt;
}

function outpointKey(outpoint: Outpoint): string {
  return `${outpoint.txid}:${outpoint.vout}`;
}

/** Keep automatic retries limited to ordinary Bitcoin funds, excluding assets and exits. */
export function isDelegationEligible(coin: ContractVtxo, scripts: Set<string>): boolean {
  return !coin.isSpent && !coin.spentBy && !coin.isUnrolled && !coin.assets?.length
    && typeof coin.contractScript === 'string' && typeof coin.script === 'string'
    && coin.tapTree !== undefined && coin.forfeitTapLeafScript !== undefined
    && coin.intentTapLeafScript !== undefined
    && scripts.has(coin.contractScript.toLowerCase())
    && coin.script.toLowerCase() === coin.contractScript.toLowerCase();
}

/**
 * Add outcome tracking to the SDK manager before starting automation. Receive events
 * and maintenance then use the same submission path: select coins needing delegation,
 * repair any unsaved acceptances, check approval, and ask the SDK to sign and submit.
 * Record what Fulmine accepted and which attempts failed; acceptance is not renewal.
 *
 * The returned queue also coordinates online settlement with submissions. Its
 * acceptance lookup tells automation which coins it should leave to Fulmine.
 */
export function installDelegationTracking(
  manager: IDelegateManager,
  options: DelegationTrackingOptions,
): DelegationSubmissions {
  const scope = { ...options.scope };
  const approved = { ...options.delegate };
  const delegateWithSdk = manager.delegate.bind(manager);
  let queueTail: Promise<unknown> = Promise.resolve();
  // Remember remote acceptance even if local persistence fails. A later attempt retries
  // saving the record, without publishing another authorization in this session.
  const acceptedInSession = new Map<string, AcceptedSubmission>();

  manager.delegate = (coins, destination, delegateAt) => {
    return runExclusive(async () => {
      options.assertCurrent();
      const selection = await selectPendingCoins(coins, destination);
      await repairAcceptedRecords(selection);
      if (!selection.pending.length) return { delegated: [], failed: [] };
      return submitAndRecord(selection, destination, delegateAt);
    });
  };
  return { runExclusive, acceptedOutpoints };

  /** Run one operation at a time; a failed operation must not block the next one. */
  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = queueTail.then(operation);
    queueTail = run.catch(() => {});
    return run;
  }

  /** Read matching acceptances from storage and this session, without submitting anything. */
  async function acceptedOutpoints(outpoints: string[], destination: string): Promise<Set<string>> {
    const saved = await getDelegationSubmissions(scope, outpoints);
    const records = new Map(saved.map((record) => [record.outpoint, record]));
    for (const key of outpoints) {
      const record = acceptedInSession.get(key);
      if (record) records.set(key, record);
    }
    return new Set(outpoints.filter((key) => {
      const record = records.get(key);
      return record?.status === 'delegated' && record.destination === destination
        && record.delegateUrl === approved.url
        && record.delegatePubkey.toLowerCase() === approved.pubkey.toLowerCase();
    }));
  }

  /**
   * Decide which of the supplied coins need a delegation attempt. First exclude
   * ineligible coins and repeated outpoints, then compare the remaining coins with
   * stored outcomes and acceptances remembered in this session.
   *
   * Skip a coin if Fulmine already accepted it for the same delegate and destination.
   * A matching failed attempt must wait for the retry cooldown; a coin with no
   * matching record can be submitted now. This step only reads and selects: it
   * does not sign, submit, or write records.
   *
   * Return both eligible and pending coins because even a skipped, accepted coin
   * may need its storage record repaired. Keep the saved records separate from the
   * combined view so the next stages can spot missing writes and prior acceptances.
   */
  async function selectPendingCoins(coins: ContractVtxo[], destination: string): Promise<SubmissionSelection> {
    const scripts = await options.eligibleScripts();
    const eligible = [...new Map(coins.filter((coin) => isDelegationEligible(coin, scripts))
      .map((coin) => [outpointKey(coin), coin])).values()];
    const saved = await getDelegationSubmissions(scope, eligible.map(outpointKey));
    const savedRecords = new Map(saved.map((record) => [record.outpoint, record]));
    const records = new Map(savedRecords);
    for (const [key, record] of acceptedInSession) records.set(key, record);
    const pending = eligible.filter((coin) => {
      const record = records.get(outpointKey(coin));
      const sameApproval = record?.destination === destination
        && record.delegateUrl === approved.url
        && record.delegatePubkey.toLowerCase() === approved.pubkey.toLowerCase();
      if (!sameApproval) return true;
      if (record.status === 'delegated') return false;
      return Date.now() - record.attemptedAt >= RETRY_DELAY_MS;
    });
    return { eligible, pending, savedRecords, records };
  }

  /**
   * Save acceptances that Fulmine confirmed but that storage has not yet recorded.
   * A previous submission may have succeeded remotely and then failed while saving
   * locally. The in-memory record lets us repair that write without asking Fulmine
   * to accept the same authorization again.
   *
   * Check every eligible coin, including accepted coins excluded from pending work.
   * Write only missing or different records. If a write fails, let the caller see
   * the error and stop this pass before making any new submission; the acceptance
   * stays in memory so a later catch-up can retry saving it.
   */
  async function repairAcceptedRecords({ eligible, savedRecords }: SubmissionSelection): Promise<void> {
    options.assertCurrent();
    // Repair only missing/changed records. Normal maintenance of accepted coins
    // must not rewrite browser storage every minute.
    await Promise.all(eligible.map(async (coin) => {
      const record = acceptedInSession.get(outpointKey(coin));
      if (record && !isAcceptanceSaved(savedRecords.get(record.outpoint), record)) {
        await setDelegationSubmission(scope, record);
      }
    }));
  }

  /**
   * Authorize and submit the pending coins, then remember the SDK's actual outcomes.
   * Check live policy and session ownership before letting the SDK construct, sign,
   * and send the authorizations. delegateAt, when supplied, is forwarded to the SDK
   * as the requested execution time.
   *
   * The SDK can throw or return a mixture of accepted coins and failed groups.
   * Remember acceptances in memory before saving them, and record failures using
   * controlled messages rather than raw SDK errors. A failed replacement must not
   * erase an earlier acceptance. A coin omitted from the result gets no new record
   * and can be reconsidered by a later catch-up.
   *
   * Acceptance means Fulmine accepted the task, not that renewal has happened. Save
   * it even if the wallet locked while waiting for the response. Return the SDK's
   * result with sanitized failure messages; thrown submission errors are sanitized
   * too, while session-lock and storage errors propagate to the caller.
   */
  async function submitAndRecord(
    { pending, records }: SubmissionSelection,
    destination: string,
    delegateAt: Parameters<IDelegateManager['delegate']>[2],
  ): Promise<Awaited<ReturnType<IDelegateManager['delegate']>>> {

    /**
     * Identify the coin, delegate, and destination this attempt concerns. Both
     * success and failure records use these fields so later selection can tell
     * whether a saved outcome matches the authorization now being requested.
     * Status and timestamps are added separately when the outcome is recorded.
     */
    const metadata = (coin: Outpoint) => ({
      outpoint: outpointKey(coin), delegateUrl: approved.url,
      delegatePubkey: approved.pubkey, destination,
    });

    /**
     * Save a failed attempt with the controlled message already supplied by the
     * caller. attemptedAt starts the retry cooldown for this delegate/destination;
     * raw SDK errors must pass through safeSubmissionError before reaching here.
     *
     * Preserve any earlier acceptance for this coin. For example, if an attempt
     * to change its destination fails, Fulmine may still hold the old authorization.
     * Marking the coin as failed would incorrectly discard that known acceptance.
     */
    const recordFailure = async (coin: Outpoint, error: Error) => {
      if (records.get(outpointKey(coin))?.status === 'delegated') return;
      await setDelegationSubmission(scope, {
        ...metadata(coin), status: 'failed', attemptedAt: Date.now(), error: error.message,
      });
    };

    let result: Awaited<ReturnType<IDelegateManager['delegate']>>;
    try {
      // Check approval before the SDK constructs or signs proofs, then fence a
      // session lock that may have happened while awaiting the policy checks.
      await options.assertDelegationAllowed();
      options.assertCurrent();
      result = await delegateWithSdk(pending, destination, delegateAt);
    } catch (error) {
      // A lock interrupts work; it is not a failed submission to retry. Preserve
      // policy errors even when their pause transition has already fenced us.
      if (!(error instanceof DelegationPolicyError)) options.assertCurrent();
      const safeError = safeSubmissionError(error);
      await Promise.all(pending.map((coin) => recordFailure(coin, safeError)));
      throw safeError;
    }

    const requested = new Set(pending.map(outpointKey));
    const acceptedOutpointKeys = new Set(result.delegated.map(outpointKey));
    for (const coin of result.delegated) {
      if (!requested.has(outpointKey(coin))) continue;
      const record: AcceptedSubmission = {
        ...metadata(coin), status: 'delegated', submittedAt: Date.now(),
      };
      acceptedInSession.set(record.outpoint, record);
    }
    // Acceptance can arrive after locking. It remains true for the original scope;
    // storing public outcome metadata requires no signing or current-session access.
    await Promise.all(result.delegated.filter((coin) => requested.has(outpointKey(coin)))
      .map((coin) => setDelegationSubmission(scope, acceptedInSession.get(outpointKey(coin))!)));
    await Promise.all(result.failed.flatMap((group) => {
      const safeError = safeSubmissionError(group.error);
      return group.outpoints
        .filter((coin) => requested.has(outpointKey(coin)) && !acceptedOutpointKeys.has(outpointKey(coin)))
        .map((coin) => recordFailure(coin, safeError));
    }));
    // SDK errors may contain signed proofs or server payloads; expose only our
    // controlled messages. A coin missing from both result lists has no new outcome,
    // so a later catch-up can try it again instead of assuming acceptance.
    return {
      delegated: result.delegated,
      failed: result.failed.map((group) => ({
        outpoints: group.outpoints, error: safeSubmissionError(group.error),
      })),
    };
  }
}
