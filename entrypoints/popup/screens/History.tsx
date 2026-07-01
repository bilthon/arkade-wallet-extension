import { useEffect, useState } from 'react';
import type { TxHistoryItem } from '@/src/wallet';
import { client, isLockedError, errorMessage } from '../client';
import { formatSats, relativeTime, truncateMiddle } from '../format';

export function History({ onClose, onLocked }: { onClose: () => void; onLocked: () => void }) {
  const [items, setItems] = useState<TxHistoryItem[] | null>(null);
  const [error, setError] = useState('');

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

      {items === null && !error && <p className="subtitle">Loading…</p>}
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
                onClick={() => void navigator.clipboard.writeText(item.txid)}
              >
                <span className="addr-mono">{truncateMiddle(item.txid)}</span>
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

function kindLabel(kind: TxHistoryItem['kind']): string {
  switch (kind) {
    case 'deposit':    return 'Deposit';
    case 'withdrawal': return 'Withdrawal';
    case 'sent':       return 'Sent';
    case 'received':   return 'Received';
  }
}
