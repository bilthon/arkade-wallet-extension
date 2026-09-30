import { useEffect, useState } from 'react';
import type { ApprovedDelegate } from '@/src/delegation-state';
import type { DelegateApproval, DelegationSettings as SettingsData } from '@/src/delegation-settings';
import type { DelegationMigrationReview, DelegationMigrationResult } from '@/src/delegation-migration';
import { client, errorMessage, isLockedError } from '../client';
import { formatSats } from '../format';

/**
 * Approval enables the automation installed by the background wallet session.
 * Moving remaining funds immediately is a separate decision. Normal renewal and
 * spending change can also move coins onto the approved receiving script.
 */
export function DelegationSettings({ onClose, onLocked }: {
  onClose: () => void;
  onLocked: () => void;
}) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [approval, setApproval] = useState<DelegateApproval | null>(null);
  const [migration, setMigration] = useState<DelegationMigrationReview | null>(null);
  const [completed, setCompleted] = useState<DelegationMigrationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    void client.getDelegationSettings().then((data) => {
      if (!cancelled) setSettings(data);
    }).catch((err) => {
      if (cancelled) return;
      if (isLockedError(err)) onLocked();
      else setError(errorMessage(err));
    });
    return () => { cancelled = true; };
  }, [onLocked]);

  // Only deliberate button actions refresh settings. Background polling here would
  // repeatedly extend auto-lock through the popup's authenticated message handlers.
  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err) {
      if (isLockedError(err)) onLocked();
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setSettings(await client.getDelegationSettings());
  }

  async function approve() {
    if (!approval) return;
    await client.approveDelegate(approval.reviewId);
    setApproval(null);
    setNotice('Delegation and automatic onboarding are enabled.');
    await refresh();
  }

  async function moveFunds() {
    if (!migration) return;
    let result: DelegationMigrationResult;
    try {
      result = await client.executeDelegationMigration(migration.reviewId);
    } catch (err) {
      // An unclear response needs a fresh review, not another click on old inputs.
      setMigration(null);
      throw err;
    }
    // Record transfer success before refreshing anything. A later error must never
    // turn the success screen back into a button that repeats the transfer.
    setCompleted(result);
    setMigration(null);
    await refresh();
  }

  return (
    <main className="screen">
      <div className="home-top">
        <h1>Delegation</h1>
        <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="subtitle" role="status">{notice}</p>}
      {!settings && !error && <p className="subtitle">Loading delegation…</p>}
      {settings && !settings.available && <p className="subtitle">Delegation is available on regtest only.</p>}
      {settings?.available && (
        <>
          <p className="subtitle">
            Status: {settings.config ? (settings.config.enabled ? 'Enabled' : 'Paused') : 'Not configured'}
          </p>
          {approval ? (
            <>
              <h2>Approve delegate</h2>
              <DelegateDetails delegate={approval.delegate} />
              <DelegationExplanation />
              <div className="btn-row">
                <button disabled={busy} onClick={() => setApproval(null)}>Cancel</button>
                <button className="btn-primary" disabled={busy} onClick={() => void runAction(approve)}>
                  Approve and enable
                </button>
              </div>
            </>
          ) : migration ? (
            <>
              <MigrationDetails review={migration} />
              <div className="btn-row">
                <button disabled={busy} onClick={() => setMigration(null)}>Cancel</button>
                <button className="btn-primary" disabled={busy} onClick={() => void runAction(moveFunds)}>
                  Confirm move
                </button>
              </div>
            </>
          ) : (
            <>
              {settings.config ? <DelegateDetails delegate={settings.config.delegate} /> : (
                <div className="addr-box">
                  <div className="addr-caption">Delegate endpoint</div>
                  <div className="addr-mono">{settings.endpoint}</div>
                </div>
              )}
              {completed && <MigrationOutcome result={completed} />}
              {settings.config && (
                <>
                  <h2>Ordinary wallet funds</h2>
                  <div className="breakdown">
                    <div className="breakdown-row"><span>Total</span><span>{formatSats(settings.summary.totalSats)} sats</span></div>
                    <div className="breakdown-row"><span>Delegated</span><span>{settings.summary.delegated} coins</span></div>
                    <div className="breakdown-row"><span>Pending</span><span>{settings.summary.pending} coins</span></div>
                    <div className="breakdown-row"><span>Failed</span><span>{settings.summary.failed} coins</span></div>
                    <div className="breakdown-row"><span>Not configured</span><span>{settings.summary.notConfigured} coins</span></div>
                  </div>
                  <p className="row-sub">Last-known local totals. Delegated means the renewal authorization was accepted, not that renewal has completed.</p>
                  {settings.summary.lastError && <p className="error">{settings.summary.lastError}</p>}
                  <div className="btn-row">
                    <button disabled={busy} onClick={() => void runAction(refresh)}>Refresh</button>
                    {settings.config.enabled && (
                      <button disabled={busy} onClick={() => void runAction(async () => {
                        await client.retryDelegation(settings.sessionId);
                        setNotice('Checked pending submissions. Failed attempts wait up to one minute before retrying.');
                        await refresh();
                      })}>Retry delegation</button>
                    )}
                  </div>
                  <p className="row-sub">Failed submissions retry while unlocked, with a one-minute delay between attempts.</p>
                </>
              )}
              <div className="btn-row">
                <button disabled={busy} onClick={() => void runAction(async () => {
                  setApproval(await client.previewDelegate());
                  setCompleted(null);
                })}>{settings.config ? 'Review delegate' : 'Set up delegation'}</button>
                {settings.config && (
                  <button disabled={busy} onClick={() => void runAction(async () => {
                    await client.setDelegationEnabled(settings.sessionId, !settings.config!.enabled);
                    await refresh();
                  })}>{settings.config.enabled ? 'Pause' : 'Resume'}</button>
                )}
              </div>
              {settings.config && (
                <p className="row-sub">
                  Pausing stops new authorizations and automatic onboarding. Your receiving address stays
                  the same, and authorizations already sent remain valid.
                </p>
              )}
              {settings.config?.enabled && (
                <>
                  <h2>Move existing funds</h2>
                  <p className="subtitle">
                    Move remaining ordinary coins to your delegation address. Escrow contracts and
                    coins carrying assets are excluded. You will review the inputs and cost first.
                  </p>
                  <button disabled={busy} onClick={() => void runAction(async () => {
                    setMigration(await client.prepareDelegationMigration());
                    setCompleted(null);
                  })}>Review move</button>
                </>
              )}
            </>
          )}
          {busy && <p className="subtitle" role="status">Working…</p>}
        </>
      )}
    </main>
  );
}

function DelegateDetails({ delegate }: { delegate: ApprovedDelegate }) {
  return (
    <div className="addr-box">
      <div className="addr-caption">Delegate endpoint</div>
      <div className="addr-mono">{delegate.url}</div>
      <div className="addr-caption">Public key</div>
      <div className="addr-mono">{delegate.pubkey}</div>
      <p className="row-sub">Delegate fee: {delegate.fee} sats. Only zero-cost delegation is supported.</p>
    </div>
  );
}

export function DelegationExplanation() {
  return (
    <>
      <p className="subtitle">
        Enabling delegation also enables automatic onboarding: confirmed on-chain deposits are
        brought into Arkade while your wallet is unlocked. Your receiving address changes to include
        the delegate. Existing addresses stay valid, but funds sent to them may need to be moved.
      </p>
      <p className="subtitle">
        The delegate can renew coins while you are offline after accepting their authorizations.
        New or replacement coins need their own authorization; reopen your wallet to catch up.
        Acceptance does not guarantee renewal.
      </p>
      <p className="banner">
        This relies on the delegate and the Arkade operator not colluding. Together they could
        take delegated funds. Only approve a delegate you trust under this assumption.
      </p>
    </>
  );
}

export function MigrationDetails({ review }: { review: DelegationMigrationReview }) {
  return (
    <>
      <h2>Review move</h2>
      <p className="subtitle">This transfers the selected coins back to your own delegation address.</p>
      <div className="breakdown">
        <div className="breakdown-row"><span>Amount</span><span>{formatSats(review.amountSats)} sats</span></div>
        <div className="breakdown-row"><span>Cost</span><span>{review.feeSats} sats</span></div>
      </div>
      <h2>Destination</h2>
      <div className="addr-box addr-mono">{review.destination}</div>
      <h2>Inputs ({review.inputs.length})</h2>
      {review.inputs.map((input) => (
        <div className="addr-box" key={`${input.txid}:${input.vout}`}>
          <div>{formatSats(input.value)} sats</div>
          <div className="addr-mono">{input.txid}:{input.vout}</div>
        </div>
      ))}
      <p className="row-sub">The wallet checks these exact coins again before signing. Delegation is requested after the transfer.</p>
    </>
  );
}

export function MigrationOutcome({ result }: { result: DelegationMigrationResult }) {
  return (
    <div role="status">
      <h2>Funds moved</h2>
      <div className="addr-mono">{result.txid}</div>
      <p className="subtitle">
        {result.delegationPending
          ? 'The transfer completed. Delegation is still pending; retry delegation without moving these funds again.'
          : 'The transfer completed and delegation was accepted for the new coins.'}
      </p>
    </div>
  );
}
