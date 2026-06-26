import { useEffect, useRef, useState } from 'react';
import { sendMessage } from '@/src/messaging';
import { READ_METHODS } from '@/src/permissions';
import type { PendingRequest } from '@/src/approvals';

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
        <h1>{state.approved ? 'Connected' : 'Declined'}</h1>
      </main>
    );
  }

  const { request } = state;
  return (
    <main className="screen">
      <h1>Connection request</h1>
      <p className="subtitle">A website wants to connect to your Arkade wallet.</p>

      {/* SW-derived origin — shown verbatim, never a site-supplied name. */}
      <div className="approval-origin">{request.origin}</div>

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

      <div className="spacer" />
      <div className="btn-row">
        <button onClick={() => respond(false)}>Reject</button>
        <button className="btn-primary" disabled={!canDecide} onClick={() => respond(true)}>
          {canDecide ? 'Connect' : 'Connect…'}
        </button>
      </div>
    </main>
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
