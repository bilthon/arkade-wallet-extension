import { useEffect, useMemo, useState } from 'react';
import type { CoinInfo } from '@/src/wallet';
import { client, isLockedError, errorMessage } from '../client';
import { formatSats, untilRelative } from '../format';
import { Send } from './Send';

/**
 * Coin control.
 *
 * Lists every VTXO with its size, remaining lifetime, and a game-style "energy bar" for
 * the fraction of life left. Spendable coins are tap-to-select; expired/recoverable coins
 * are shown but dimmed and not selectable (they're the coins the user most wants to SEE,
 * but coin selection would refuse them). Selecting coins and tapping the footer opens the
 * Send screen locked to exactly those inputs.
 */

type Sort = 'time' | 'size';

export function CoinControl({
  onClose,
  onLocked,
}: {
  onClose: () => void;
  onLocked: () => void;
}) {
  const [coins, setCoins] = useState<CoinInfo[] | null>(null);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<Sort>('time');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showSend, setShowSend] = useState(false);
  // Bumped after a send to re-list the coins (spent ones gone, change coin appears).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCoins(null);
    (async () => {
      try {
        const { coins } = await client.listCoins();
        if (!cancelled) setCoins(coins);
      } catch (err) {
        if (cancelled) return;
        if (isLockedError(err)) {
          onLocked();
          return;
        }
        setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onLocked, reloadKey]);

  // Sorted view. "Time left" is ascending (most urgent first) with unknown-expiry coins
  // last; "Size" is descending. We never mutate the source array.
  const sortedCoins = useMemo(() => {
    if (!coins) return null;
    const copy = [...coins];
    if (sort === 'size') {
      copy.sort((a, b) => b.value - a.value);
    } else {
      copy.sort((a, b) => {
        if (a.expiresAtMs === null && b.expiresAtMs === null) return 0;
        if (a.expiresAtMs === null) return 1;
        if (b.expiresAtMs === null) return -1;
        return a.expiresAtMs - b.expiresAtMs;
      });
    }
    return copy;
  }, [coins, sort]);

  function toggle(outpoint: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(outpoint)) next.delete(outpoint);
      else next.add(outpoint);
      return next;
    });
  }

  const selectedCoins = (coins ?? []).filter((c) => selected.has(c.outpoint));
  const selectedSats = selectedCoins.reduce((sum, c) => sum + c.value, 0);
  const selectedOutpoints = selectedCoins.map((c) => c.outpoint);

  // Spend the selection: hand the exact outpoints + their total to Send, which locks to
  // Arkade-only sends and caps the amount at the total.
  if (showSend && selectedOutpoints.length > 0) {
    return (
      <Send
        availableSats={selectedSats}
        coinSelection={{ outpoints: selectedOutpoints, totalSats: selectedSats }}
        onClose={() => setShowSend(false)}
        onLocked={onLocked}
        onSent={() => {
          setShowSend(false);
          setSelected(new Set());
          setReloadKey((k) => k + 1);
          // Keep the home balance in step with the coins we just spent.
          void client.refreshWalletSnapshot().catch(() => {});
        }}
      />
    );
  }

  return (
    <main className="screen">
      <div className="home-top">
        <h1>Coin control</h1>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="toggle" role="tablist">
        <button className={sort === 'time' ? 'active' : ''} onClick={() => setSort('time')}>
          Time left
        </button>
        <button className={sort === 'size' ? 'active' : ''} onClick={() => setSort('size')}>
          Size
        </button>
      </div>

      {coins === null && !error && (
        <div aria-busy="true" aria-label="Loading coins">
          {Array.from({ length: 5 }, (_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {coins !== null && coins.length === 0 && <p className="subtitle">No coins yet.</p>}

      {sortedCoins?.map((coin) => (
        <CoinRow
          key={coin.outpoint}
          coin={coin}
          selected={selected.has(coin.outpoint)}
          onToggle={() => toggle(coin.outpoint)}
        />
      ))}

      {selectedOutpoints.length > 0 && (
        <>
          <div className="spacer" />
          <button
            className="btn-primary btn-block"
            style={{ marginTop: 12 }}
            onClick={() => setShowSend(true)}
          >
            Spend {selectedOutpoints.length} coin{selectedOutpoints.length !== 1 ? 's' : ''} ·{' '}
            {formatSats(selectedSats)} sats
          </button>
        </>
      )}
    </main>
  );
}

/** One coin row: size + lifetime on the left, energy bar + selection check on the right.
 *  Spendable coins are tappable; expired/recoverable coins are dimmed and inert. */
function CoinRow({
  coin,
  selected,
  onToggle,
}: {
  coin: CoinInfo;
  selected: boolean;
  onToggle: () => void;
}) {
  const selectable = coin.state === 'spendable';
  const ratio = lifeRatio(coin);
  const cls = [
    'row',
    'coin-row',
    selectable ? 'selectable' : 'disabled',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      onClick={selectable ? onToggle : undefined}
      role={selectable ? 'button' : undefined}
      aria-pressed={selectable ? selected : undefined}
    >
      <div>
        <div className="row-label">{formatSats(coin.value)} sats</div>
        <div className="row-sub">
          {coin.state === 'spendable' ? (
            coin.expiresAtMs === null ? (
              'expiry unknown'
            ) : (
              `${untilRelative(coin.expiresAtMs)} left`
            )
          ) : coin.state === 'expired' ? (
            <span className="pill">needs renewal</span>
          ) : (
            <span className="pill">needs recovery</span>
          )}
        </div>
      </div>
      <div className="coin-right">
        {ratio !== null && (
          <div className="energy" aria-hidden="true">
            <div
              className={`energy-fill ${energyClass(ratio)}`}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
        )}
        {selectable && (
          <span className={`coin-check ${selected ? 'on' : ''}`} aria-hidden="true">
            {selected ? '✓' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

/** A shimmering placeholder row that mirrors a real coin row's shape. */
function SkeletonRow() {
  return (
    <div className="row" aria-hidden="true">
      <div>
        <div className="skeleton-shimmer" style={{ width: 96, height: 14, marginBottom: 7 }} />
        <div className="skeleton-shimmer" style={{ width: 60, height: 10 }} />
      </div>
      <div className="skeleton-shimmer" style={{ width: 48, height: 6 }} />
    </div>
  );
}

/**
 * Fraction of a coin's lifetime still remaining, in [0, 1], or null when the expiry is
 * unknown (a regtest block-height expiry we can't count down to). There's no server
 * constant for total lifetime, so we derive it per coin from created -> expiry.
 */
function lifeRatio(coin: CoinInfo): number | null {
  if (coin.expiresAtMs === null) return null;
  const total = coin.expiresAtMs - coin.createdAtMs;
  if (total <= 0) return null;
  const left = coin.expiresAtMs - Date.now();
  return Math.max(0, Math.min(1, left / total));
}

/** Energy-bar color by remaining fraction, reusing the password strength-meter palette:
 *  green > 50%, yellow > 25%, amber > 10%, red at/below 10%. */
function energyClass(ratio: number): string {
  if (ratio > 0.5) return 'on-4';
  if (ratio > 0.25) return 'on-3';
  if (ratio > 0.1) return 'on-2';
  return 'on-1';
}
