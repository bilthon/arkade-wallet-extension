import { useEffect, useState } from 'react';
import { client, isLockedError, errorMessage } from '../client';
import { formatSats } from '../format';

type Stage = 'entry' | 'confirm' | 'done';

export function Send({
  availableSats,
  onClose,
  onLocked,
  onSent,
}: {
  availableSats: number;
  onClose: () => void;
  onLocked: () => void;
  onSent: () => void;
}) {
  const [stage, setStage] = useState<Stage>('entry');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [txid, setTxid] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [settled, setSettled] = useState(false);

  // Anti-fat-finger: enable the confirm button only after ~450ms.
  useEffect(() => {
    if (stage !== 'confirm') return;
    setSettled(false);
    const id = setTimeout(() => setSettled(true), 450);
    return () => clearTimeout(id);
  }, [stage]);

  const amountNum = parseInt(amount, 10);
  const entryValid = address.trim().length > 0 && Number.isInteger(amountNum) && amountNum > 0;

  async function send() {
    setSending(true);
    setError('');
    try {
      const { txid: id } = await client.sendBitcoin(address.trim(), amountNum);
      setTxid(id);
      setStage('done');
    } catch (err) {
      if (isLockedError(err)) {
        onLocked();
        return;
      }
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  if (stage === 'done') {
    return (
      <main className="screen">
        <div className="home-top">
          <h1>Sent</h1>
        </div>
        <p className="subtitle">Instant — stayed within Arkade.</p>
        <div className="addr-box">
          <div className="addr-caption">Transaction ID</div>
          <div className="addr-mono">{txid}</div>
        </div>
        <div className="spacer" />
        <div className="btn-row">
          <button className="btn-primary" onClick={onSent}>
            Done
          </button>
        </div>
      </main>
    );
  }

  if (stage === 'confirm') {
    return (
      <main className="screen">
        <div className="home-top">
          <h1>Confirm send</h1>
          <button className="icon-btn" onClick={() => setStage('entry')} aria-label="Back">
            ✕
          </button>
        </div>

        <label>Recipient</label>
        <div className="addr-box" style={{ marginTop: 4 }}>
          <div className="addr-mono">{address.trim()}</div>
        </div>

        <label>Amount</label>
        <div style={{ fontSize: 20, fontWeight: 700, margin: '4px 0 8px' }}>
          {formatSats(amountNum)} sats
        </div>

        <div className="addr-box">
          <div className="addr-caption">Instant · ~zero fee · stays within Arkade</div>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="spacer" />
        <div className="btn-row">
          <button className="link-btn" onClick={() => { setError(''); setStage('entry'); }}>
            Back
          </button>
          <button
            className="btn-primary"
            disabled={!settled || sending}
            onClick={send}
          >
            {sending ? 'Sending…' : 'Confirm & send'}
          </button>
        </div>
      </main>
    );
  }

  // stage === 'entry'
  return (
    <main className="screen">
      <div className="home-top">
        <h1>Send</h1>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <label htmlFor="send-address">Arkade address</label>
      <input
        id="send-address"
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="ark1q…"
      />

      <label htmlFor="send-amount">Amount (sats)</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          id="send-amount"
          type="number"
          inputMode="numeric"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          style={{ flex: 1 }}
        />
        <button
          onClick={() => setAmount(String(availableSats))}
          disabled={availableSats === 0}
        >
          Max
        </button>
      </div>
      <div className="row-sub" style={{ marginTop: 4 }}>
        Available: {formatSats(availableSats)} sats
      </div>

      <div className="spacer" />
      <div className="btn-row">
        <button
          className="btn-primary"
          disabled={!entryValid}
          onClick={() => setStage('confirm')}
        >
          Review
        </button>
      </div>
    </main>
  );
}
