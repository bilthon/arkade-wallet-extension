import { useEffect, useState } from 'react';
import type { TxHistoryItem } from '@/src/wallet';
import { client, isLockedError, errorMessage } from '../client';
import { formatSats, relativeTime, truncateMiddle } from '../format';

export function History({ onClose, onLocked }: { onClose: () => void; onLocked: () => void }) {
  const [items, setItems] = useState<TxHistoryItem[] | null>(null);
  const [error, setError] = useState('');
  // Index of the row whose txid was just copied → shows a brief "Copied ✓" acknowledgement.
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  async function copyTxid(txid: string, idx: number) {
    try {
      await navigator.clipboard.writeText(txid);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    } catch {
      /* clipboard unavailable (rare in a focused popup) — nothing to show */
    }
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const result = await client.getTransactionHistory();
        if (!cancelled) setItems(result);
      } catch (err) {
        if (cancelled) return;
        if (isLockedError(err)) { onLocked(); return; }
        setError(errorMessage(err));
      }
    })();

    return () => { cancelled = true; };
  }, [onLocked]);

  return (
    <main className="screen">
      <div className="home-top">
        <h1>Activity</h1>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {items === null && !error && (
        <div aria-busy="true" aria-label="Loading transactions">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {items !== null && items.length === 0 && <p className="subtitle">No transactions yet.</p>}

      {items !== null && items.map((item, i) => (
        <div className="row" key={i}>
          <div>
            <div className="row-label">
              {kindLabel(item.kind)}
              {!item.settled && (
                <span className="pill" style={{ marginLeft: 6, fontSize: 10 }}>pending</span>
              )}
            </div>
            <div className="row-sub">{relativeTime(item.createdAt)}</div>
            {item.txid && (
              <button
                className="link-btn"
                style={{ padding: 0, fontSize: 11 }}
                onClick={() => void copyTxid(item.txid, i)}
                title="Copy transaction ID"
                aria-label="Copy transaction ID"
              >
                <span className="addr-mono">
                  {copiedIdx === i ? 'Copied ✓' : truncateMiddle(item.txid)}
                </span>
              </button>
            )}
          </div>
          <div className="breakdown-amount" style={{ whiteSpace: 'nowrap' }}>
            {item.incoming ? '+' : '−'}{formatSats(item.amount)} sats
          </div>
        </div>
      ))}
    </main>
  );
}

/** A shimmering placeholder row that mirrors the real transaction row's shape. */
function SkeletonRow() {
  return (
    <div className="row" aria-hidden="true">
      <div>
        <div className="skeleton-shimmer" style={{ width: 88, height: 14, marginBottom: 7 }} />
        <div className="skeleton-shimmer" style={{ width: 54, height: 10, marginBottom: 7 }} />
        <div className="skeleton-shimmer" style={{ width: 128, height: 10 }} />
      </div>
      <div className="skeleton-shimmer" style={{ width: 76, height: 14 }} />
    </div>
  );
}

function kindLabel(kind: TxHistoryItem['kind']): string {
  switch (kind) {
    case 'deposit':    return 'Deposit';
    case 'withdrawal': return 'Withdrawal';
    case 'sent':       return 'Sent';
    case 'received':   return 'Received';
  }
}
