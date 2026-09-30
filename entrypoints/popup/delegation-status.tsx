import type { CoinDelegationInfo, DelegationSettings } from '@/src/delegation-settings';
import type { CoinInfo } from '@/src/wallet';

const labels = {
  delegated: 'Delegated',
  pending: 'Pending',
  failed: 'Failed',
  'not-configured': 'Not configured',
};

/** Saved authorization results describe this exact coin, not whether renewal finished. */
export function CoinDelegationDetails({ info, state }: {
  info: CoinDelegationInfo | undefined;
  state: CoinInfo['state'];
}) {
  // Once a coin expires, its renewal/recovery warning takes priority over acceptance.
  // Hide the old success detail without changing the saved authorization.
  if (info?.status === 'delegated' && state !== 'spendable') return null;

  // Coin and status reads can see different snapshots while funds arrive or are spent.
  // A missing entry is unknown; it must not look like a confirmed Not configured result.
  if (!info) return <div className="coin-delegation">Delegation status unavailable.</div>;

  return (
    <div className="coin-delegation">
      <span
        className={`pill delegation-${info.status}`}
        title={info.status === 'delegated' ? `Accepted ${new Date(info.submittedAt).toLocaleString()}` : undefined}
      >
        {labels[info.status]}
      </span>
      {info.status === 'failed' && (
        <>
          <span>Last attempt <SubmissionTime at={info.attemptedAt} /></span>
          <p>{info.error}</p>
        </>
      )}
      {info.status === 'not-configured' && <p>{info.reason}</p>}
    </div>
  );
}

/** Use an absolute time: these saved results do not update while the screen stays open. */
function SubmissionTime({ at }: { at: number }) {
  const date = new Date(at);
  return <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>;
}

/** The home view uses the same counts as settings, without querying the delegate. */
export function DelegationSummary({ settings }: { settings: DelegationSettings }) {
  const { summary, config } = settings;
  return (
    <section className="delegation-summary" aria-label="Delegation summary">
      <div>Delegation · {config ? (config.enabled ? 'Enabled' : 'Paused') : 'Not configured'}</div>
      <div className="delegation-counts">
        <span className="delegation-delegated">{summary.delegated} Delegated</span>
        <span className="delegation-pending">{summary.pending} Pending</span>
        <span className="delegation-failed">{summary.failed} Failed</span>
        <span className="delegation-not-configured">{summary.notConfigured} Not configured</span>
      </div>
    </section>
  );
}
