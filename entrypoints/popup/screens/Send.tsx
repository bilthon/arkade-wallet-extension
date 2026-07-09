import { useEffect, useRef, useState } from 'react';
import { client, isLockedError, errorMessage } from '../client';
import { formatSats } from '../format';
import { NetworkName } from '@arkade-os/sdk';
import type { LnPayStatus } from '@/src/lightning-utils';

/** Dust floor (sats) — mirrors the SW's authoritative DUST_SATS; used here only to
 * pre-gate the Review button so the user doesn't wait out the settle-delay to fail. */
const DUST_SATS = 330;

/** Prefix check — mirrors `validateOnchainAddress` in wallet.ts. Network-agnostic
 *  because the SW re-validates with the active network before signing. */
function isOnchainAddress(addr: string): boolean {
  const l = addr.trim().toLowerCase();
  return l.startsWith('bc1') || l.startsWith('tb1') || l.startsWith('bcrt1');
}

/**
 * Detect a BOLT11 invoice in the address field (optionally as a `lightning:`
 * URI) and return it normalized, or null. Prefix check only — the SW decodes
 * and re-validates before anything signs, same division of labor as the
 * address modes. `lnbc` (mainnet) / `lntb` (testnet) / `lntbs` (signet/
 * mutinynet) / `lnbcrt` (regtest) are the BOLT11 HRPs; none collide with
 * `ark`/`tark`/`bc1`-style addresses.
 */
function parseLightningInvoice(raw: string): string | null {
  let l = raw.trim().toLowerCase();
  if (l.startsWith('lightning:')) l = l.slice('lightning:'.length);
  return l.startsWith('lnbc') || l.startsWith('lntb') || l.startsWith('lnbcrt') ? l : null;
}

/** Quote returned by the SW for a BOLT11 invoice — the numbers the user confirms. */
interface LnPayQuote {
  amountSats: number;
  feeSats: number;
  totalSats: number;
  description: string;
}

const LN_PAY_STATUS_TEXT: Record<LnPayStatus, string> = {
  sending: 'Paying invoice…',
  paid: 'Paid!',
  'refund-pending': 'Payment failed — returning your funds…',
  refunded: 'Payment failed. Your funds were returned to your wallet.',
};

type Stage = 'entry' | 'confirm' | 'lnwait' | 'done';

export function Send({
  availableSats,
  coinSelection,
  onClose,
  onLocked,
  onSent,
}: {
  availableSats: number;
  /** Coin control: when present, the send is locked to exactly these coins (Arkade-only)
   *  and the caller sets `availableSats` to their total. */
  coinSelection?: { outpoints: string[]; totalSats: number };
  onClose: () => void;
  onLocked: () => void;
  onSent: () => void;
}) {
  const [network, setNetwork] = useState<NetworkName | null>(null)
  const [stage, setStage] = useState<Stage>('entry');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [txid, setTxid] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [settled, setSettled] = useState(false);
  // On-chain Max: true when the user clicked Max in on-chain mode → omit amount from
  // offboard call so the SDK offboards everything and deducts the fee internally.
  const [sendAll, setSendAll] = useState(false);
  // Lightning: the SW's quote (fetched on Review), the pending swap id, and its
  // polled status. Quote + swapId survive the stage transitions; status drives lnwait.
  const [lnQuote, setLnQuote] = useState<LnPayQuote | null>(null);
  const [lnSwapId, setLnSwapId] = useState('');
  const [lnStatus, setLnStatus] = useState<LnPayStatus>('sending');
  const [quoting, setQuoting] = useState(false);
  // Synchronous re-entrancy guard: flips before the first await so two clicks in the
  // same tick can't both issue a send (the `sending` state guard only applies after a
  // re-render). This is the spend path — a double-send would spend distinct VTXOs.
  const inFlight = useRef(false);

  // Anti-fat-finger: enable the confirm button only after ~450ms.
  useEffect(() => {
    if (stage !== 'confirm') return;
    setSettled(false);
    const id = setTimeout(() => setSettled(true), 450);
    return () => clearTimeout(id);
  }, [stage]);

  useEffect(() => {
    let cancelled = false
    void client.getNetwork().then(({ network }) => {
      if (!cancelled) setNetwork(network)
    })
    return () => { cancelled = true }
  }, [])

  // Strict integer parse: reject any non-digit tail (parseInt('5e3')→5, '50x'→50).
  const amountNum = /^\d+$/.test(amount.trim()) ? Number(amount.trim()) : NaN;
  const lnInvoice = parseLightningInvoice(address);
  const lnMode = lnInvoice !== null;
  const onchainMode = !lnMode && isOnchainAddress(address);
  // Coin control: this send is locked to a chosen coin set, which only Arkade→Arkade
  // sends support. A Lightning invoice or on-chain address in this mode is rejected up
  // front (they run their own input-selection flows).
  const coinLocked = coinSelection != null;
  const unsupportedForSelection = coinLocked && (lnMode || onchainMode);
  // sendAll bypasses the amount bounds check (on-chain Max → SDK handles fee deduction).
  // Lightning bypasses it entirely — the invoice fixes the amount; the balance check
  // happens against the quote's fee-inclusive total on Review.
  const entryValid =
    address.trim().length > 0 &&
    !unsupportedForSelection &&
    (lnMode ||
      sendAll ||
      (Number.isInteger(amountNum) && amountNum >= DUST_SATS && amountNum <= availableSats));

  // Review (Lightning): fetch the quote from the SW — it decodes the invoice and
  // rejects malformed/amountless/out-of-limits ones with a message we show inline.
  // The fee-inclusive total is checked against the available balance HERE, where
  // the total is first known.
  async function reviewLightning() {
    if (!lnInvoice || quoting) return;
    setQuoting(true);
    setError('');
    try {
      const q = await client.getLightningPayQuote(lnInvoice);
      if (q.totalSats > availableSats) {
        setError(
          `Total with fees (${formatSats(q.totalSats)} sats) exceeds your available balance.`,
        );
        return;
      }
      setLnQuote(q);
      setStage('confirm');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setQuoting(false);
    }
  }

  // Status poll for a pending Lightning payment, mirroring Receive's ~2.5s poll.
  // Also what keeps the SW alive so its SwapManager can track the swap (and
  // auto-refund a failure). Stops on the terminal states; 'refund-pending' is
  // NOT terminal — it resolves to 'refunded' once the funds are back.
  useEffect(() => {
    if (stage !== 'lnwait' || !lnSwapId) return;
    if (lnStatus === 'paid' || lnStatus === 'refunded') return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const { status: s } = await client.getLightningPayStatus(lnSwapId);
        if (cancelled) return;
        setLnStatus(s);
        if (s === 'paid' || s === 'refunded') void client.refreshWalletSnapshot();
      } catch {
        // Transient poll failure; try again next tick.
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stage, lnSwapId, lnStatus]);

  async function send() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError('');
    try {
      let id: string;
      if (lnMode && lnInvoice && lnQuote) {
        // maxTotalSats echoes the quoted total the user just confirmed — the SW
        // aborts before funding if Boltz asks for more. Resolves once the swap
        // is funded; the outcome then arrives via the lnwait status poll.
        const r = await client.payLightningInvoice(lnInvoice, lnQuote.totalSats);
        setLnSwapId(r.swapId);
        setLnStatus('sending');
        setStage('lnwait');
        return;
      }
      if (onchainMode) {
        // For on-chain Max (sendAll), omit amount — SDK offboards everything and
        // deducts the network fee internally. Explicit amount passes as BigInt SW-side.
        ({ txid: id } = await client.sendOnchain(
          address.trim(),
          sendAll ? undefined : amountNum,
        ));
      } else {
        // Coin control passes the exact outpoints so the SW spends only those inputs.
        ({ txid: id } = await client.send(address.trim(), amountNum, coinSelection?.outpoints));
      }
      setTxid(id);
      setStage('done');
    } catch (err) {
      if (isLockedError(err)) {
        onLocked();
        return;
      }
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  if (stage === 'lnwait' && lnQuote) {
    const terminal = lnStatus === 'paid' || lnStatus === 'refunded';
    return (
      <main className="screen">
        <div className="home-top">
          <h1>
            {lnStatus === 'paid'
              ? 'Paid'
              : lnStatus === 'refunded'
                ? 'Payment failed'
                : 'Paying…'}
          </h1>
          {/* Escape hatch while non-terminal: the swap continues SW-side (manager
              + reconcile-on-unlock), so leaving is safe — funds either arrive or
              come back. onSent so the already-debited balance refreshes. */}
          {!terminal && (
            <button className="icon-btn" onClick={onSent} aria-label="Close">
              ✕
            </button>
          )}
        </div>

        {lnStatus === 'paid' ? (
          <p className="subtitle">
            Sent {formatSats(lnQuote.amountSats)} sats over Lightning.
          </p>
        ) : (
          <div className={terminal ? 'row-sub' : 'row-sub ln-pending'}>
            {LN_PAY_STATUS_TEXT[lnStatus]}
          </div>
        )}

        {!terminal && (
          <div className="row-sub" style={{ marginTop: 8 }}>
            Keep this window open until the payment completes.
          </div>
        )}

        <div className="spacer" />
        {terminal && (
          <div className="btn-row">
            {/* onSent for both outcomes — a refund also changed the balance. */}
            <button className="btn-primary" onClick={onSent}>
              Done
            </button>
          </div>
        )}
      </main>
    );
  }

  if (stage === 'done') {
    return (
      <main className="screen">
        <div className="home-top">
          <h1>{onchainMode ? 'Withdrawal submitted' : 'Sent'}</h1>
        </div>
        <p className="subtitle">
          {onchainMode
            ? 'Broadcast on-chain — pending confirmation.'
            : 'Instant — stayed within Arkade.'}
        </p>
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

  if (stage === 'confirm' && lnMode && lnQuote) {
    return (
      <main className="screen">
        <div className="home-top">
          <h1>Confirm payment</h1>
          <button className="icon-btn" onClick={() => setStage('entry')} aria-label="Back">
            ✕
          </button>
        </div>

        <label>Lightning invoice</label>
        <div className="addr-box" style={{ marginTop: 4 }}>
          {lnQuote.description && (
            <div className="addr-caption">{lnQuote.description}</div>
          )}
          <div className="addr-mono">{lnInvoice}</div>
        </div>

        <label>Amount</label>
        <div style={{ fontSize: 20, fontWeight: 700, margin: '4px 0 8px' }}>
          {formatSats(lnQuote.amountSats)} sats
        </div>

        <div className="addr-box">
          <div className="addr-caption">
            Via Lightning · swap fee ~{formatSats(lnQuote.feeSats)} sats · total{' '}
            {formatSats(lnQuote.totalSats)} sats
          </div>
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
            {sending ? 'Paying…' : 'Confirm & pay'}
          </button>
        </div>
      </main>
    );
  }

  if (stage === 'confirm') {
    return (
      <main className="screen">
        <div className="home-top">
          <h1>{onchainMode ? 'Confirm withdrawal' : 'Confirm send'}</h1>
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
          {sendAll ? `${formatSats(availableSats)} sats (Max)` : `${formatSats(amountNum)} sats`}
        </div>

        <div className="addr-box">
          {onchainMode ? (
            <div className="addr-caption">
              On-chain · the recipient receives this minus the network fee · exits Arkade · not instant
            </div>
          ) : (
            <div className="addr-caption">
              Instant · ~zero fee · stays within Arkade
              {coinLocked &&
                ` · from ${coinSelection.outpoints.length} selected coin${
                  coinSelection.outpoints.length !== 1 ? 's' : ''
                }`}
            </div>
          )}
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
            {sending
              ? (onchainMode ? 'Withdrawing… (up to a minute)' : 'Sending…')
              : (onchainMode ? 'Confirm & withdraw' : 'Confirm & send')}
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

      <label htmlFor="send-address">
        Bitcoin or Arkade address, or Lightning invoice
      </label>
      <input
        id="send-address"
        type="text"
        autoCapitalize="none"
        autoCorrect="off"
        value={address}
        onChange={(e) => { setAddress(e.target.value); setSendAll(false); setError(''); }}
        placeholder={
          network === 'bitcoin' ? 'bc1… / ark1q… / lnbc…' : 'tb1… / bcrt1… / tark1q… / lnbc…'
        }
      />

      {/* Lightning: the invoice fixes the amount, so the amount inputs drop away. */}
      {lnMode ? (
        <div className="row-sub" style={{ marginTop: 4 }}>
          Lightning invoice — the amount is set by the invoice. Available:{' '}
          {formatSats(availableSats)} sats
        </div>
      ) : (
        <>
          <label htmlFor="send-amount">Amount (sats)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              id="send-amount"
              type="number"
              inputMode="numeric"
              min={1}
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setSendAll(false); }}
              placeholder="0"
              style={{ flex: 1 }}
            />
            <button
              onClick={() => {
                setAmount(String(availableSats));
                // On-chain Max: signal send-all so the SW offboards everything and
                // deducts the fee internally (amount omitted from offboard call).
                if (onchainMode) setSendAll(true);
              }}
              disabled={availableSats === 0}
            >
              Max
            </button>
          </div>
          <div className="row-sub" style={{ marginTop: 4 }}>
            {coinLocked ? (
              <>
                Spending {coinSelection.outpoints.length} selected coin
                {coinSelection.outpoints.length !== 1 ? 's' : ''} · {formatSats(availableSats)} sats
                available
              </>
            ) : (
              <>
                Available: {formatSats(availableSats)} sats
                {onchainMode &&
                  ' · use Max to withdraw everything (the network fee is taken from it)'}
              </>
            )}
          </div>
        </>
      )}

      {unsupportedForSelection && (
        <div className="error">Selected-coin spends only support Arkade addresses.</div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="spacer" />
      <div className="btn-row">
        <button
          className="btn-primary"
          disabled={!entryValid || quoting}
          onClick={() => (lnMode ? void reviewLightning() : setStage('confirm'))}
        >
          {quoting ? 'Fetching quote…' : 'Review'}
        </button>
      </div>
    </main>
  );
}
