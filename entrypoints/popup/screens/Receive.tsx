import { useEffect, useState } from 'react';
import { client, isLockedError, errorMessage } from '../client';
import { formatSats, untilRelative } from '../format';
import { invoiceAmountForTarget, type LnReceiveStatus } from '@/src/lightning';

/**
 * Receive view. Arkade / On-chain / Lightning tabs (Arkade default), each with a
 * one-line "what/when" caption + a Copy button. The Lightning tab only appears once
 * `getLightningInfo()` (fetched once on mount) confirms the active network supports
 * it; while that's pending or false, the popup behaves exactly like before — two tabs.
 * Lightning itself is a single stateful subcomponent (`LightningReceive`) since it
 * talks to the SW (form → create invoice → poll for the deposit landing), unlike the
 * two address tabs which just render already-known strings.
 *
 * ponytail: QR is a fast-follow — Copy ships now (no QR yet). Copy here is an explicit
 * user action on a receive address (public), distinct from the no-auto-clipboard rule
 * that applies to the seed phrase.
 */
export function Receive({
  arkAddress,
  boardingAddress,
  onClose,
  onLocked,
}: {
  arkAddress: string;
  boardingAddress: string;
  onClose: () => void;
  onLocked: () => void;
}) {
  const [tab, setTab] = useState<'arkade' | 'onchain' | 'lightning'>('arkade');
  const [copied, setCopied] = useState(false);
  const [lnInfo, setLnInfo] = useState<LnAvailability>({ status: 'loading' });

  // Fetched once, up front, so we know whether to show the Lightning tab button at
  // all — safe while locked (getLightningInfo needs no wallet). A Boltz-reachability
  // failure is treated the same as "not available": fail closed, hide the tab.
  useEffect(() => {
    let cancelled = false;
    client
      .getLightningInfo()
      .then((info) => {
        if (cancelled) return;
        setLnInfo(
          info.available && info.limits && info.fees
            ? { status: 'available', limits: info.limits, fees: info.fees }
            : { status: 'unavailable' },
        );
      })
      .catch(() => {
        if (!cancelled) setLnInfo({ status: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isArkade = tab === 'arkade';
  const isLightning = tab === 'lightning';
  const address = isArkade ? arkAddress : boardingAddress;
  const caption = isArkade
    ? 'Arkade address — instant, near-zero fee. Best for Arkade-to-Arkade payments.'
    : 'On-chain boarding address — deposit regular Bitcoin here. It appears under "Boarding"; becoming spendable in Arkade (onboarding) ships in a later update.';

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked; the address is shown for manual copy regardless.
    }
  }

  return (
    <main className="screen">
      <div className="home-top">
        <h1>Receive</h1>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="toggle" role="tablist">
        <button
          className={isArkade ? 'active' : ''}
          role="tab"
          aria-selected={isArkade}
          onClick={() => setTab('arkade')}
        >
          Arkade
        </button>
        <button
          className={tab === 'onchain' ? 'active' : ''}
          role="tab"
          aria-selected={tab === 'onchain'}
          onClick={() => setTab('onchain')}
        >
          On-chain
        </button>
        {lnInfo.status === 'available' && (
          <button
            className={isLightning ? 'active' : ''}
            role="tab"
            aria-selected={isLightning}
            onClick={() => setTab('lightning')}
          >
            Lightning
          </button>
        )}
      </div>

      {isLightning && lnInfo.status === 'available' ? (
        <LightningReceive limits={lnInfo.limits} fees={lnInfo.fees} onLocked={onLocked} />
      ) : (
        <>
          <div className="addr-box">
            <div className="addr-caption">{caption}</div>
            <div className="addr-mono">{address}</div>
          </div>

          <div className="btn-row">
            <button className="btn-primary" onClick={copy}>
              {copied ? 'Copied' : 'Copy address'}
            </button>
          </div>
        </>
      )}
    </main>
  );
}

type LnLimits = { min: number; max: number };
type LnFees = { percentage: number; minerFeesTotal: number };
type LnAvailability =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'available'; limits: LnLimits; fees: LnFees };

type LnInvoice = {
  invoice: string;
  swapId: string;
  invoiceAmount: number;
  receiveAmount: number;
  expiresAt: number;
};

const LN_STATUS_TEXT: Record<LnReceiveStatus, string> = {
  waiting: 'Waiting for payment…',
  claiming: 'Payment received — moving funds into your wallet…',
  done: 'Received!',
  expired: 'Invoice expired — create a new one.',
  failed: 'Swap failed — no funds were taken.',
};

/**
 * Lightning receive tab. Two stages in one component (form → invoice), mirroring how
 * Send.tsx handles its own multi-stage flow. The amount input is denominated in what
 * the user wants to RECEIVE; the invoice (sender-side) amount is derived with the
 * shared `invoiceAmountForTarget` helper and Boltz's min/max limits — which apply to
 * that derived invoice amount — are converted back through the same formula so the
 * error text stays in terms of what the user actually typed.
 *
 * Once an invoice is created, a single effect pair drives both the 1s countdown
 * re-render and the ~2.5s status poll. Local expiry (countdown hits 0) only changes
 * what's SHOWN — polling keeps going until Boltz's own status turns terminal
 * (done/expired/failed), since that's the source of truth a late payment could still
 * land against. Both effects tear down on unmount (tab switch away, or Receive
 * closing), so nothing polls in the background once this screen isn't visible.
 */
function LightningReceive({
  limits,
  fees,
  onLocked,
}: {
  limits: LnLimits;
  fees: LnFees;
  onLocked: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  const [invoice, setInvoice] = useState<LnInvoice | null>(null);
  const [status, setStatus] = useState<LnReceiveStatus>('waiting');
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0); // forces a re-render each second for the countdown

  // Strict integer parse, mirroring Send.tsx.
  const targetNum = /^\d+$/.test(amount.trim()) ? Number(amount.trim()) : NaN;
  const hasTarget = Number.isInteger(targetNum) && targetNum > 0;
  const invoiceAmount = hasTarget ? invoiceAmountForTarget(targetNum, fees) : 0;

  let boundsError = '';
  if (hasTarget && invoiceAmount < limits.min) {
    const minReceive = Math.max(
      0,
      Math.round((limits.min * (100 - fees.percentage)) / 100 - fees.minerFeesTotal),
    );
    boundsError = `Minimum receive amount is about ${formatSats(minReceive)} sats.`;
  } else if (hasTarget && invoiceAmount > limits.max) {
    const maxReceive = Math.round(
      (limits.max * (100 - fees.percentage)) / 100 - fees.minerFeesTotal,
    );
    boundsError = `Maximum receive amount is about ${formatSats(maxReceive)} sats.`;
  }

  const canCreate = hasTarget && !boundsError && !creating;
  const terminal = status === 'done' || status === 'expired' || status === 'failed';

  async function createInvoice() {
    if (!canCreate) return;
    setCreating(true);
    setFormError('');
    try {
      const r = await client.createLightningInvoice(invoiceAmount);
      setInvoice({
        invoice: r.invoice,
        swapId: r.swapId,
        invoiceAmount,
        receiveAmount: r.receiveAmount,
        expiresAt: r.expiresAt,
      });
      setStatus('waiting');
    } catch (err) {
      if (isLockedError(err)) {
        onLocked();
        return;
      }
      setFormError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  // Countdown tick — just forces a re-render every second while an invoice is up and
  // still pending; the actual time-left is computed fresh from `invoice.expiresAt`.
  useEffect(() => {
    if (!invoice || terminal) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [invoice, terminal]);

  // Status poll — Boltz's source of truth. Stops once `status` itself is terminal;
  // a locally-expired countdown does NOT stop this on its own (see doc comment above).
  useEffect(() => {
    if (!invoice || terminal) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const { status: s } = await client.getLightningReceiveStatus(invoice.swapId);
        if (cancelled) return;
        setStatus(s);
        if (s === 'done') void client.refreshWalletSnapshot();
      } catch {
        // Transient poll failure; try again next tick.
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [invoice, terminal]);

  async function copyInvoice() {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice.invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked; the invoice is shown for manual copy regardless.
    }
  }

  function resetToForm() {
    setInvoice(null);
    setStatus('waiting');
  }

  if (invoice) {
    const locallyExpired = invoice.expiresAt - Date.now() <= 0;
    const shown: LnReceiveStatus = status === 'waiting' && locallyExpired ? 'expired' : status;

    return (
      <>
        <div className="addr-box">
          <div className="addr-caption">
            Invoice for {formatSats(invoice.invoiceAmount)} sats — you'll receive{' '}
            {formatSats(invoice.receiveAmount)} sats
          </div>
          <div className="addr-mono">{invoice.invoice}</div>
        </div>

        <div className="btn-row">
          <button className="btn-primary" onClick={copyInvoice}>
            {copied ? 'Copied' : 'Copy invoice'}
          </button>
        </div>

        {shown === 'waiting' && (
          <div className="row-sub" style={{ marginTop: 8 }}>
            Expires in {untilRelative(invoice.expiresAt)}
          </div>
        )}
        <div className="row-sub" style={{ marginTop: 4 }}>
          {LN_STATUS_TEXT[shown]}
        </div>

        {(shown === 'expired' || shown === 'failed') && (
          <div className="btn-row">
            <button className="btn-primary" onClick={resetToForm}>
              {shown === 'expired' ? 'Create a new invoice' : 'Try again'}
            </button>
          </div>
        )}

        <p className="renewal-note" style={{ marginTop: 8 }}>
          Keep this window open until the payment arrives. If you close it, the deposit
          completes the next time you unlock.
        </p>
      </>
    );
  }

  return (
    <>
      <label htmlFor="ln-amount">Amount to receive (sats)</label>
      <input
        id="ln-amount"
        type="number"
        inputMode="numeric"
        min={1}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0"
      />
      {hasTarget && !boundsError && (
        <div className="row-sub" style={{ marginTop: 4 }}>
          The sender will pay ≈ {formatSats(invoiceAmount)} sats (estimate — fees are
          Boltz's; the exact amounts are shown once the invoice is created).
        </div>
      )}
      {boundsError && <div className="error">{boundsError}</div>}
      {formError && <div className="error">{formError}</div>}

      <div className="btn-row">
        <button className="btn-primary" disabled={!canCreate} onClick={createInvoice}>
          {creating ? 'Creating invoice…' : 'Create invoice'}
        </button>
      </div>
    </>
  );
}
