import { useState } from 'react';

/**
 * Receive view (team-lead brief #5). A single Receive entry with an Arkade / On-chain
 * toggle (Arkade default), each with a one-line "what/when" caption + a Copy button.
 *
 * ponytail: QR is a fast-follow — Copy ships now (no QR yet). Copy here is an explicit
 * user action on a receive address (public), distinct from the no-auto-clipboard rule
 * that applies to the seed phrase.
 */
export function Receive({
  arkAddress,
  boardingAddress,
  onClose,
}: {
  arkAddress: string;
  boardingAddress: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'arkade' | 'onchain'>('arkade');
  const [copied, setCopied] = useState(false);

  const isArkade = tab === 'arkade';
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
          className={!isArkade ? 'active' : ''}
          role="tab"
          aria-selected={!isArkade}
          onClick={() => setTab('onchain')}
        >
          On-chain
        </button>
      </div>

      <div className="addr-box">
        <div className="addr-caption">{caption}</div>
        <div className="addr-mono">{address}</div>
      </div>

      <div className="btn-row">
        <button className="btn-primary" onClick={copy}>
          {copied ? 'Copied' : 'Copy address'}
        </button>
      </div>
    </main>
  );
}
