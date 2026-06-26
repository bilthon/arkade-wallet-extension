import { useEffect, useRef, useState } from 'react';
import { sendMessage } from '@/src/messaging';
import { READ_METHODS } from '@/src/permissions';
import type { PendingRequest } from '@/src/approvals';
import type { PsbtSummary, LeafClause } from '@/src/psbt-inspect';

/**
 * Approval window (PLAN.md §7, Track E2a). Rendered in a dedicated browser popup window
 * — NOT an in-page modal — so a malicious web app cannot iframe or overlay it. The page
 * also declares CSP `frame-ancestors 'none'` (wxt.config.ts) so it can never be embedded.
 *
 * Anti-clickjacking measures:
 *  • The origin shown is the SW-DERIVED origin (read back from the background by
 *    requestId), never a site-supplied label.
 *  • A ~500 ms settle-delay keeps the Approve button disabled after the window opens,
 *    so a web app that pops the window timed to a user's click can't get a blind approval.
 *
 * The window reads its `requestId` from the query string, fetches the request, shows it,
 * and posts the user's decision back via `approvalResponse` — which resolves the web app's
 * original `connect()` promise in the background.
 */

const SETTLE_DELAY_MS = 500;

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; request: PendingRequest }
  | { phase: 'gone' } // stale/expired request (window outlived it)
  | { phase: 'done'; approved: boolean };

export function ApprovalPage() {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [canDecide, setCanDecide] = useState(false);
  const requestIdRef = useRef<string | null>(null);

  // Read the requestId from the URL and fetch the (SW-derived) request.
  useEffect(() => {
    const requestId = new URLSearchParams(location.search).get('requestId');
    requestIdRef.current = requestId;
    if (!requestId) {
      setState({ phase: 'gone' });
      return;
    }
    void sendMessage('getApprovalRequest', { requestId }).then(({ request }) => {
      if (request) setState({ phase: 'ready', request });
      else setState({ phase: 'gone' });
    });
  }, []);

  // Settle-delay: enable the buttons only after the window has been visible a beat.
  useEffect(() => {
    if (state.phase !== 'ready') return;
    const t = setTimeout(() => setCanDecide(true), SETTLE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state.phase]);

  async function respond(approved: boolean) {
    const requestId = requestIdRef.current;
    if (!requestId) return;
    setState({ phase: 'done', approved });
    await sendMessage('approvalResponse', { requestId, approved });
    // Close the window; the background promise is already resolved.
    window.close();
  }

  if (state.phase === 'loading') {
    return <main className="screen" />;
  }

  if (state.phase === 'gone') {
    return (
      <main className="screen">
        <h1>Request expired</h1>
        <p className="subtitle">
          This connection request is no longer available. Close this window and try again
          from the site.
        </p>
        <div className="spacer" />
        <button className="btn-block" onClick={() => window.close()}>
          Close
        </button>
      </main>
    );
  }

  if (state.phase === 'done') {
    return (
      <main className="screen">
        <h1>{state.approved ? doneLabel(state) : 'Declined'}</h1>
      </main>
    );
  }

  const { request } = state;
  return (
    <main className="screen">
      {/* SW-derived origin — shown verbatim, never a site-supplied name. Shown on every
          approval kind so the user always sees who is asking. */}
      <ApprovalHeader kind={request.kind} origin={request.origin} />

      {request.payload.kind === 'connect' && <ConnectBody />}
      {request.payload.kind === 'signMessage' && (
        <SignMessageBody message={request.payload.message} />
      )}
      {request.payload.kind === 'signPsbt' && (
        <SignPsbtBody summary={request.payload.summary} />
      )}

      <div className="spacer" />
      <div className="btn-row">
        <button onClick={() => respond(false)}>Reject</button>
        <button className="btn-primary" disabled={!canDecide} onClick={() => respond(true)}>
          {confirmLabel(request.kind, canDecide)}
        </button>
      </div>
    </main>
  );
}

// ─── per-kind header + bodies ────────────────────────────────────────────────────

function ApprovalHeader({ kind, origin }: { kind: string; origin: string }) {
  const title =
    kind === 'signMessage'
      ? 'Signature request'
      : kind === 'signPsbt'
        ? 'Transaction signature'
        : 'Connection request';
  const subtitle =
    kind === 'signMessage'
      ? 'A website is asking you to sign a message with your Arkade key.'
      : kind === 'signPsbt'
        ? 'A website is asking you to sign a Bitcoin transaction.'
        : 'A website wants to connect to your Arkade wallet.';
  return (
    <>
      <h1>{title}</h1>
      <p className="subtitle">{subtitle}</p>
      <div className="approval-origin">{origin}</div>
    </>
  );
}

function ConnectBody() {
  return (
    <>
      <p>This site will be able to read:</p>
      <ul className="approval-perms">
        {READ_METHODS.map((m) => (
          <li key={m}>{readLabel(m)}</li>
        ))}
      </ul>
      <p className="approval-note">
        It cannot move funds or sign anything. Signing requests will always ask you
        again. You can disconnect this site any time in Settings.
      </p>
    </>
  );
}

/** Show the exact message that will be BIP322-signed. Rendered verbatim, monospaced,
 *  so the user reads precisely what they authorize (sighash-shaped input is rejected
 *  upstream and never reaches this view). */
function SignMessageBody({ message }: { message: string }) {
  return (
    <>
      <p>You are signing this message:</p>
      <pre className="approval-message">{message}</pre>
      <p className="approval-note">
        This produces a BIP-322 signature with your key — it cannot move funds. Only
        approve if you recognise this site and this message.
      </p>
    </>
  );
}

/** The thick signing diff (own-coin) or the contract co-sign view, driven by the
 *  SW-computed summary (never a site-supplied claim). */
function SignPsbtBody({ summary }: { summary: PsbtSummary }) {
  return (
    <>
      {summary.isContractCoSign ? (
        <ContractCoSignView summary={summary} />
      ) : (
        <OwnCoinView summary={summary} />
      )}
      {summary.flags.length > 0 && <DangerFlags flags={summary.flags} />}
    </>
  );
}

/** Own-coin spend: total leaving, external destinations, fee, inputs we sign. */
function OwnCoinView({ summary }: { summary: PsbtSummary }) {
  const external = summary.outputs.filter((o) => !o.isOwnChange && o.address !== null);
  return (
    <>
      <div className="approval-amount">
        <span className="approval-amount-label">Total leaving your wallet</span>
        <span className="approval-amount-value">{fmtSats(summary.totalLeaving)}</span>
      </div>
      {external.length > 0 && (
        <>
          <p>Sending to:</p>
          <ul className="approval-outputs">
            {external.map((o) => (
              <li key={o.index}>
                <code>{shortAddr(o.address!)}</code>
                <span>{fmtSats(o.amount)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <FeeAndInputs summary={summary} />
    </>
  );
}

/** Contract co-sign: name the leaf clause, role ("1 of N"), destination + amount. */
function ContractCoSignView({ summary }: { summary: PsbtSummary }) {
  const contractInputs = summary.signInputs.filter((si) => si.role === 'contract');
  const addressed = summary.outputs.filter((o) => o.address !== null);
  return (
    <>
      <p className="approval-note">
        This is a <strong>contract co-signature</strong>. You are one of several required
        signers on a shared Bitcoin contract — your signature alone cannot move the funds.
      </p>
      <ul className="approval-outputs">
        {contractInputs.map((si) => (
          <li key={si.index} className="approval-cosign">
            <div>
              <strong>{clauseLabel(si.contract!.clause)}</strong>
            </div>
            <div className="approval-role">
              You are signing 1 of {si.contract!.required} required signatures
            </div>
            {si.contract!.timelock && (
              <div className="approval-timelock">
                {si.contract!.timelock.kind === 'csv'
                  ? `Relative timelock: ${si.contract!.timelock.value}`
                  : `Locked until: ${si.contract!.timelock.value}`}
              </div>
            )}
            <div className="approval-amount-value">{fmtSats(si.amount)}</div>
          </li>
        ))}
      </ul>
      {addressed.length > 0 && (
        <>
          <p>Paying out to:</p>
          <ul className="approval-outputs">
            {addressed.map((o) => (
              <li key={o.index}>
                <code>{shortAddr(o.address!)}</code>
                <span>
                  {fmtSats(o.amount)}
                  {o.isOwnChange ? ' (you)' : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function FeeAndInputs({ summary }: { summary: PsbtSummary }) {
  return (
    <p className="approval-note">
      {summary.fee !== null ? `Fee: ${fmtSats(summary.fee)}. ` : ''}
      Signing {summary.signInputs.length}{' '}
      {summary.signInputs.length === 1 ? 'input' : 'inputs'}. The signature is added but the
      transaction is returned unfinalised.
    </p>
  );
}

function DangerFlags({ flags }: { flags: string[] }) {
  return (
    <ul className="approval-flags">
      {flags.map((f) => (
        <li key={f} className="approval-flag">
          ⚠ {flagLabel(f)}
        </li>
      ))}
    </ul>
  );
}

/** Human label for each granted read method shown on the approval screen. */
function readLabel(method: string): string {
  switch (method) {
    case 'getAccounts':
      return 'Your connected account';
    case 'getAddress':
      return 'Your Arkade address';
    case 'getBoardingAddress':
      return 'Your on-chain boarding address';
    case 'getPublicKey':
      return 'Your public key';
    case 'getBalance':
      return 'Your balance';
    case 'getNetwork':
      return 'The active network';
    default:
      return method;
  }
}

/** The success heading shown briefly after approve, per kind. */
function doneLabel(state: { approved: boolean }): string {
  return state.approved ? 'Approved' : 'Declined';
}

/** The confirm-button label per kind (and its pre-settle "…" state). */
function confirmLabel(kind: string, canDecide: boolean): string {
  const base = kind === 'connect' ? 'Connect' : kind === 'signMessage' ? 'Sign' : 'Sign';
  return canDecide ? base : `${base}…`;
}

/** Human label for a contract co-sign leaf clause. */
function clauseLabel(clause: LeafClause): string {
  switch (clause) {
    case 'cooperative':
      return 'Cooperative release';
    case 'timeout-refund':
      return 'Timeout refund';
    case 'unilateral-exit':
      return 'Unilateral exit';
    case 'conditional':
      return 'Conditional (e.g. hashlock)';
    case 'conditional-exit':
      return 'Conditional exit';
    default:
      return clause;
  }
}

/** Human label for a danger flag. */
function flagLabel(flag: string): string {
  switch (flag) {
    case 'SWEEP':
      return 'This transaction drains your wallet — nothing comes back as change.';
    case 'UNILATERAL_EXIT':
      return 'This spends a unilateral-exit path (an on-chain escape route).';
    case 'OP_RETURN':
      return 'This embeds data (OP_RETURN) in the transaction.';
    case 'NONSTANDARD_OUTPUT':
      return 'This pays to a script the wallet could not decode to an address.';
    default:
      return flag;
  }
}

/** sats with thousands separators + a unit. */
function fmtSats(sats: number): string {
  return `${sats.toLocaleString('en-US')} sats`;
}

/** Truncate a long address for display (head…tail). */
function shortAddr(addr: string): string {
  return addr.length <= 24 ? addr : `${addr.slice(0, 12)}…${addr.slice(-8)}`;
}
