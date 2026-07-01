import { useEffect, useState } from 'react';
import type { NetworkName } from '@arkade-os/sdk';
import type { AdjustedBalance } from '@/src/vtxo-state';
import { type RenewalWarning, isWarningStale } from '@/src/renewal';
import { client, isLockedError, errorMessage } from '../client';
import { formatSats, networkLabel, relativeTime, untilRelative } from '../format';
import { Receive } from './Receive';
import { Send } from './Send';
import { History } from './History';

/**
 * Wallet home (Track D + the UX review, team-lead brief #5; Track F renewal UI).
 *
 * Cache-first render: we read the cached snapshot from the SW first so addresses +
 * last-known balance paint INSTANTLY (or skeletons if never fetched — never a fake 0).
 * Then we fire a live reconciliation; on success we re-render with fresh figures, on
 * failure we keep the cached values and show an operator-unreachable banner.
 *
 * Available is the hero; Preconfirmed / Settled / Boarding sit in a quiet "Also in
 * your wallet" list with plain-language (i) tooltips — no alarmist colors (Phase 5).
 * Expired coins surface in a distinct section with a Renew action (Track F).
 */
export function WalletHome({
  onLocked,
  onSettings,
}: {
  onLocked: () => void;
  onSettings: () => void;
}) {
  const [network, setNetwork] = useState<NetworkName | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [boardingAddress, setBoardingAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<AdjustedBalance | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loadingLive, setLoadingLive] = useState(true);
  const [offline, setOffline] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [renewalWarning, setRenewalWarning] = useState<RenewalWarning | null>(null);
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [recoverError, setRecoverError] = useState('');
  const [onboardBusy, setOnboardBusy] = useState(false);
  const [onboardError, setOnboardError] = useState('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 0) Fetch renewal warning — safe while locked, so do it first for the fallback banner.
      try {
        const { warning } = await client.getRenewalWarning();
        if (!cancelled) setRenewalWarning(warning);
      } catch {
        // Non-critical; ignore.
      }

      // 1) Instant cached paint.
      try {
        const { network } = await client.getNetwork();
        if (!cancelled) setNetwork(network);
        const { snapshot } = await client.getWalletSnapshot();
        if (!cancelled && snapshot) {
          setAddress(snapshot.address);
          setBoardingAddress(snapshot.boardingAddress);
          setBalance(snapshot.balance as AdjustedBalance);
          setFetchedAt(snapshot.fetchedAt);
        }
      } catch {
        // Cached read should not fail; ignore and let the live read drive state.
      }

      // 2) Best-effort live reconciliation.
      try {
        const { snapshot } = await client.refreshWalletSnapshot();
        if (cancelled) return;
        setAddress(snapshot.address);
        setBoardingAddress(snapshot.boardingAddress);
        setBalance(snapshot.balance as AdjustedBalance);
        setFetchedAt(snapshot.fetchedAt);
        setOffline(false);
      } catch (err) {
        if (cancelled) return;
        if (isLockedError(err)) {
          onLocked();
          return;
        }
        // Operator unreachable — keep cached values, flag offline.
        setOffline(true);
      } finally {
        if (!cancelled) setLoadingLive(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onLocked, reloadKey]);

  async function lock() {
    await client.lock();
    onLocked();
  }

  async function handleRecover() {
    if (recoverBusy) return;
    setRecoverBusy(true);
    setRecoverError('');
    try {
      await client.recoverNow();
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (isLockedError(err)) {
        onLocked();
        return;
      }
      setRecoverError(errorMessage(err));
    } finally {
      setRecoverBusy(false);
    }
  }

  async function handleOnboard() {
    if (onboardBusy) return;
    setOnboardBusy(true);
    setOnboardError('');
    try {
      await client.onboardNow();
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (isLockedError(err)) {
        onLocked();
        return;
      }
      setOnboardError(errorMessage(err));
    } finally {
      setOnboardBusy(false);
    }
  }

  if (showReceive && address && boardingAddress) {
    return (
      <Receive
        arkAddress={address}
        boardingAddress={boardingAddress}
        onClose={() => setShowReceive(false)}
      />
    );
  }

  if (showSend) {
    return (
      <Send
        availableSats={balance?.available ?? 0}
        onClose={() => setShowSend(false)}
        onLocked={onLocked}
        onSent={() => {
          setShowSend(false);
          setReloadKey((k) => k + 1);
        }}
      />
    );
  }

  if (showHistory) {
    return <History onClose={() => setShowHistory(false)} onLocked={onLocked} />;
  }

  // First-ever open with no cache yet and a live read still in flight → skeletons.
  const showSkeleton = balance === null && loadingLive;
  const isEmpty = balance !== null && balance.total === 0;

  const adjBalance = balance as AdjustedBalance | null;
  // ALREADY-EXPIRED funds are a RECOVERY target, not renewal. The SDK's recovery set
  // (`recoverVtxos`) covers BOTH time-expired-but-unswept (`isSpendable && isExpired`)
  // and swept (`isRecoverable`) coins; feeding either to `renewVtxos` is the reproduced
  // INVALID_INTENT_PROOF bug. So both balance buckets drive the single Recover action.
  // (Renewal is the proactive path for coins not yet expired — surfaced as the "next
  // renewal due in …" countdown below, handled automatically by the scheduler.)
  const liveRecoverSats =
    adjBalance !== null ? adjBalance.expired + adjBalance.recoverableSats : 0;
  const hasLiveAttention = liveRecoverSats > 0;

  // Locked-warning banner: only when we have no fresh balance to drive the live Recover
  // section, and the cached warning flags work to do. Stamp it stale when written a
  // prior session ago (the SW may have respawned locked since).
  const warnRecoverSats =
    renewalWarning !== null
      ? renewalWarning.expiredSats + renewalWarning.recoverableSats
      : 0;
  const showWarningBanner = !hasLiveAttention && warnRecoverSats > 0;
  const warningStale = renewalWarning !== null && isWarningStale(renewalWarning);

  // Recover section: all already-expired funds (live, or cached fallback).
  const recoverSats = liveRecoverSats > 0 ? liveRecoverSats : warnRecoverSats;
  const showRecoverSection = !showSkeleton && recoverSats > 0;

  return (
    <main className="screen">
      <div className="home-top">
        <span className="pill">{network ? networkLabel(network) : '…'}</span>
        <div>
          <button className="icon-btn" onClick={onSettings} aria-label="Settings" title="Settings">
            ⚙
          </button>
          <button className="icon-btn" onClick={lock} aria-label="Lock" title="Lock">
            🔒
          </button>
        </div>
      </div>

      {offline && (
        <div className="banner">
          Can't reach the operator right now. Showing your last known balance
          {fetchedAt ? ` (${relativeTime(fetchedAt)})` : ''}.
        </div>
      )}

      {showWarningBanner && (
        <div className="banner">
          {warningStale ? (
            <>
              Last we checked, some coins had expired and needed recovery
              {` (${relativeTime(renewalWarning!.at)})`}. Unlock to refresh and recover
              them.
            </>
          ) : (
            <>
              {warnBannerCounts(renewalWarning!)} expired — unlock to recover.
            </>
          )}
        </div>
      )}

      {/* Hero: Available */}
      <div className="hero">
        <div className="hero-label">Available</div>
        {showSkeleton ? (
          <div className="skeleton" style={{ height: 38, width: 180, margin: '6px auto' }} />
        ) : (
          <div>
            <span className="hero-amount">{formatSats(adjBalance?.available ?? 0)}</span>
            <span className="hero-unit">sats</span>
          </div>
        )}
      </div>

      {isEmpty ? (
        <EmptyState onReceive={() => setShowReceive(true)} />
      ) : (
        <>
          {showSkeleton ? (
            <SkeletonBreakdown />
          ) : (
            <Breakdown
              balance={adjBalance!}
              onboardBusy={onboardBusy}
              onboardError={onboardError}
              onOnboard={handleOnboard}
            />
          )}

          {/* Recover: all already-expired funds (time-expired-unswept + swept) →
              recoverVtxos. Renewal is NOT offered for these — feeding an expired coin
              to renewVtxos is the reproduced INVALID_INTENT_PROOF bug; the operator
              re-issues them via the recovery round instead. */}
          {showRecoverSection && (
            <RecoverySection
              sats={recoverSats}
              busy={recoverBusy}
              error={recoverError}
              onAction={handleRecover}
            />
          )}

          <div className="btn-row">
            <button
              className="btn-primary"
              disabled={(adjBalance?.available ?? 0) === 0 || !address || !boardingAddress}
              onClick={() => setShowSend(true)}
            >
              Send
            </button>
            <button
              className="btn-primary"
              disabled={!address || !boardingAddress}
              onClick={() => setShowReceive(true)}
            >
              Receive
            </button>
          </div>
          <button
            className="link-btn btn-block"
            style={{ textAlign: 'center', marginTop: 4 }}
            onClick={() => setShowHistory(true)}
          >
            Activity
          </button>
        </>
      )}

      {fetchedAt && !offline && (
        <div className="staleness">
          Updated {relativeTime(fetchedAt)}
          {adjBalance?.nextExpiryAtMs != null &&
            adjBalance.nextExpiryAtMs > Date.now() &&
            ` · Next renewal due in ${untilRelative(adjBalance.nextExpiryAtMs)}`}
        </div>
      )}
    </main>
  );
}

/** Compose the locked-warning banner count text across both expired buckets. */
function warnBannerCounts(w: RenewalWarning): string {
  const coins = w.count + w.recoverableCount;
  const sats = w.expiredSats + w.recoverableSats;
  return `${coins} coin${coins !== 1 ? 's' : ''} (${formatSats(sats)} sats)`;
}

/**
 * Action card for the recovery bucket: already-expired funds (time-expired-unswept +
 * swept) the operator re-issues via `recoverVtxos`. Renewal is deliberately NOT offered
 * for these — feeding an expired coin to `renewVtxos` is the reproduced bug. Warn
 * palette only, not red/danger.
 */
function AttentionSection({
  label,
  tip,
  note,
  sats,
  busy,
  busyLabel,
  actionLabel,
  error,
  onAction,
}: {
  label: string;
  tip: string;
  note: string;
  sats: number;
  busy: boolean;
  busyLabel: string;
  actionLabel: string;
  error: string;
  onAction: () => void;
}) {
  return (
    <div className="renewal-section">
      <div className="breakdown-row" style={{ alignItems: 'flex-start' }}>
        <span className="breakdown-label" style={{ color: 'var(--warn-text)' }}>
          {label}
          <span className="info" title={tip}>
            i
          </span>
        </span>
        <span className="breakdown-amount" style={{ color: 'var(--warn-text)' }}>
          {formatSats(sats)} sats
        </span>
      </div>
      <p className="renewal-note">{note}</p>
      {error && <p className="error" style={{ marginTop: 6 }}>{error}</p>}
      <button
        className="btn-primary btn-block"
        style={{ marginTop: 8 }}
        disabled={busy}
        onClick={onAction}
      >
        {busy ? busyLabel : actionLabel}
      </button>
    </div>
  );
}

/**
 * Recover already-expired funds — both time-expired-but-unswept and operator-swept
 * coins. The operator re-issues them in a fresh batch (`recoverVtxos`). The user keeps
 * spending authority throughout; recovery just makes them spendable again.
 */
function RecoverySection({
  sats,
  busy,
  error,
  onAction,
}: {
  sats: number;
  busy: boolean;
  error: string;
  onAction: () => void;
}) {
  return (
    <AttentionSection
      label="Needs recovery"
      tip="These coins passed their batch expiry. You keep spending authority — recovering re-issues them back to your wallet so you can spend them again."
      note="These coins expired and aren't spendable until recovered."
      sats={sats}
      busy={busy}
      busyLabel="Recovering…"
      actionLabel="Recover now"
      error={error}
      onAction={onAction}
    />
  );
}

/**
 * "Also in your wallet" — the non-Available states, with plain-language tooltips
 * (PLAN.md §6 spirit). Boarding shown only when it carries funds (it's an on-chain
 * pre-onboard state most users won't have). No alarmist colors at MVP.
 */
function Breakdown({
  balance,
  onboardBusy,
  onboardError,
  onOnboard,
}: {
  balance: AdjustedBalance;
  onboardBusy: boolean;
  onboardError: string;
  onOnboard: () => void;
}) {
  const rows: Array<{ label: string; amount: number; tip: string }> = [
    {
      label: 'Preconfirmed',
      amount: balance.preconfirmed,
      tip: 'Cosigned by the operator and spendable now, but not yet anchored to Bitcoin.',
    },
    {
      label: 'Settled',
      amount: balance.settled,
      tip: 'Anchored to Bitcoin in a batch — final.',
    },
  ];

  const hasBoarding = balance.boarding.total > 0;
  if (hasBoarding) {
    rows.push({
      label: 'Boarding',
      amount: balance.boarding.total,
      tip: 'On-chain deposits waiting to be onboarded into Arkade.',
    });
  }

  // Nothing beyond Available to elaborate on → skip the section entirely.
  if (rows.every((r) => r.amount === 0) && !hasBoarding) return null;

  return (
    <div className="breakdown">
      <div className="breakdown-title">Also in your wallet</div>
      {rows.map((r) => (
        <div className="breakdown-row" key={r.label}>
          <span className="breakdown-label">
            {r.label}
            <span className="info" title={r.tip}>
              i
            </span>
          </span>
          <span className="breakdown-amount">{formatSats(r.amount)} sats</span>
        </div>
      ))}
      {hasBoarding && balance.boarding.confirmed > 0 && (
        <div className="breakdown-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <p className="renewal-note" style={{ margin: 0 }}>
            Move your on-chain deposit into Arkade so you can spend it.
          </p>
          {onboardError && <p className="error" style={{ marginTop: 0 }}>{onboardError}</p>}
          <button
            className="btn-primary btn-block"
            disabled={onboardBusy}
            onClick={onOnboard}
          >
            {onboardBusy ? 'Onboarding…' : 'Onboard'}
          </button>
        </div>
      )}
    </div>
  );
}

function SkeletonBreakdown() {
  return (
    <div className="breakdown">
      <div className="breakdown-title">Also in your wallet</div>
      {[0, 1].map((i) => (
        <div className="breakdown-row" key={i}>
          <span className="skeleton" style={{ height: 12, width: 90 }} />
          <span className="skeleton" style={{ height: 12, width: 60 }} />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onReceive }: { onReceive: () => void }) {
  return (
    <div className="center" style={{ padding: '20px 0' }}>
      <p className="subtitle">Your wallet is empty. Receive some bitcoin to get started.</p>
      <button className="btn-primary btn-block" onClick={onReceive}>
        Receive
      </button>
    </div>
  );
}
