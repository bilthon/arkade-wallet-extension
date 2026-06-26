import { useEffect, useState } from 'react';
import type { NetworkName } from '@arkade-os/sdk';
import type { AdjustedBalance } from '@/src/vtxo-state';
import type { RenewalWarning } from '@/src/renewal';
import { client, isLockedError, errorMessage } from '../client';
import { formatSats, networkLabel, relativeTime, untilRelative } from '../format';
import { Receive } from './Receive';
import { Send } from './Send';

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
  const [reloadKey, setReloadKey] = useState(0);
  const [renewalWarning, setRenewalWarning] = useState<RenewalWarning | null>(null);
  const [renewBusy, setRenewBusy] = useState(false);
  const [renewError, setRenewError] = useState('');
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

  async function handleRenew() {
    if (renewBusy) return;
    setRenewBusy(true);
    setRenewError('');
    try {
      await client.renewNow();
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (isLockedError(err)) {
        onLocked();
        return;
      }
      setRenewError(errorMessage(err));
    } finally {
      setRenewBusy(false);
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

  // First-ever open with no cache yet and a live read still in flight → skeletons.
  const showSkeleton = balance === null && loadingLive;
  const isEmpty = balance !== null && balance.total === 0;

  // Show the locked warning banner only when we have no live balance with expired > 0.
  // Once we have a fresh balance, the RenewalSection below takes over.
  const hasLiveExpired = balance !== null && (balance as AdjustedBalance).expired > 0;
  const showWarningBanner =
    !hasLiveExpired && renewalWarning !== null && renewalWarning.expiredSats > 0;

  const adjBalance = balance as AdjustedBalance | null;
  const hasExpired = adjBalance !== null && adjBalance.expired > 0;
  const showRenewSection =
    hasExpired || (renewalWarning !== null && renewalWarning.expiredSats > 0);

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
          {renewalWarning!.count} coin{renewalWarning!.count !== 1 ? 's' : ''} (
          {formatSats(renewalWarning!.expiredSats)} sats) need renewal — unlock to renew.
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

          {/* Renewal section: expired coins + renew button */}
          {!showSkeleton && showRenewSection && (
            <RenewalSection
              expiredSats={adjBalance?.expired ?? renewalWarning?.expiredSats ?? 0}
              busy={renewBusy}
              error={renewError}
              onRenew={handleRenew}
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

/**
 * Expired-coin section. Shown above the Send/Receive row when funds need renewal.
 * Uses warn palette only — not red/danger.
 */
function RenewalSection({
  expiredSats,
  busy,
  error,
  onRenew,
}: {
  expiredSats: number;
  busy: boolean;
  error: string;
  onRenew: () => void;
}) {
  return (
    <div className="renewal-section">
      <div className="breakdown-row" style={{ alignItems: 'flex-start' }}>
        <span className="breakdown-label" style={{ color: 'var(--warn-text)' }}>
          Needs renewal
          <span
            className="info"
            title="While expired, a coin is no longer self-custodial — the operator could eventually sweep it. Renew to restore full custody."
          >
            i
          </span>
        </span>
        <span className="breakdown-amount" style={{ color: 'var(--warn-text)' }}>
          {formatSats(expiredSats)} sats
        </span>
      </div>
      <p className="renewal-note">These coins expired and aren't spendable until renewed.</p>
      {error && <p className="error" style={{ marginTop: 6 }}>{error}</p>}
      <button
        className="btn-primary btn-block"
        style={{ marginTop: 8 }}
        disabled={busy}
        onClick={onRenew}
      >
        {busy ? 'Renewing…' : 'Renew now'}
      </button>
    </div>
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
