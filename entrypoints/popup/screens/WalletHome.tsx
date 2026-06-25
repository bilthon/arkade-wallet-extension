import { useEffect, useState } from 'react';
import type { NetworkName, WalletBalance } from '@arkade-os/sdk';
import { client, isLockedError } from '../client';
import { formatSats, networkLabel, relativeTime } from '../format';
import { Receive } from './Receive';

/**
 * Wallet home (Track D + the UX review, team-lead brief #5).
 *
 * Cache-first render: we read the cached snapshot from the SW first so addresses +
 * last-known balance paint INSTANTLY (or skeletons if never fetched — never a fake 0).
 * Then we fire a live reconciliation; on success we re-render with fresh figures, on
 * failure we keep the cached values and show an operator-unreachable banner.
 *
 * Available is the hero; Preconfirmed / Settled / Boarding sit in a quiet "Also in
 * your wallet" list with plain-language (i) tooltips — no alarmist colors (Phase 5).
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
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loadingLive, setLoadingLive] = useState(true);
  const [offline, setOffline] = useState(false);
  const [showReceive, setShowReceive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1) Instant cached paint.
      try {
        const { network } = await client.getNetwork();
        if (!cancelled) setNetwork(network);
        const { snapshot } = await client.getWalletSnapshot();
        if (!cancelled && snapshot) {
          setAddress(snapshot.address);
          setBoardingAddress(snapshot.boardingAddress);
          setBalance(snapshot.balance);
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
        setBalance(snapshot.balance);
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
  }, [onLocked]);

  async function lock() {
    await client.lock();
    onLocked();
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

  // First-ever open with no cache yet and a live read still in flight → skeletons.
  const showSkeleton = balance === null && loadingLive;
  const isEmpty = balance !== null && balance.total === 0;

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

      {/* Hero: Available */}
      <div className="hero">
        <div className="hero-label">Available</div>
        {showSkeleton ? (
          <div className="skeleton" style={{ height: 38, width: 180, margin: '6px auto' }} />
        ) : (
          <div>
            <span className="hero-amount">{formatSats(balance?.available ?? 0)}</span>
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
            <Breakdown balance={balance!} />
          )}

          <div className="btn-row">
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
        <div className="staleness">Updated {relativeTime(fetchedAt)}</div>
      )}
    </main>
  );
}

/**
 * "Also in your wallet" — the non-Available states, with plain-language tooltips
 * (PLAN.md §6 spirit). Boarding shown only when it carries funds (it's an on-chain
 * pre-onboard state most users won't have). No alarmist colors at MVP.
 */
function Breakdown({ balance }: { balance: WalletBalance }) {
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
  if (balance.boarding.total > 0) {
    rows.push({
      label: 'Boarding',
      amount: balance.boarding.total,
      tip: 'On-chain deposits waiting to be onboarded into Arkade.',
    });
  }

  // Nothing beyond Available to elaborate on → skip the section entirely.
  if (rows.every((r) => r.amount === 0) && balance.boarding.total === 0) return null;

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
