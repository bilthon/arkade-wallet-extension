import { useEffect, useState } from 'react';
import type { NetworkName } from '@arkade-os/sdk';
import { client } from '../client';
import { networkLabel } from '../format';

/**
 * Settings-lite (team-lead brief, ponytail trims): read-only network pill, manual
 * lock, and backup re-reveal behind re-auth. No interactive network picker yet.
 */
export function Settings({ onBack, onLocked }: { onBack: () => void; onLocked: () => void }) {
  const [network, setNetwork] = useState<NetworkName | null>(null);
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    void client.getNetwork().then(({ network }) => setNetwork(network));
  }, []);

  async function lock() {
    await client.lock();
    onLocked();
  }

  if (revealing) {
    return <RevealBackup onClose={() => setRevealing(false)} />;
  }

  return (
    <main className="screen">
      <div className="home-top">
        <h1>Settings</h1>
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          ✕
        </button>
      </div>

      <div className="row">
        <div>
          <div className="row-label">Network</div>
          <div className="row-sub">Read-only for now.</div>
        </div>
        <span className="pill">{network ? networkLabel(network) : '…'}</span>
      </div>

      <div className="row">
        <div>
          <div className="row-label">Recovery phrase</div>
          <div className="row-sub">Reveal your backup (asks for your password).</div>
        </div>
        <button onClick={() => setRevealing(true)}>Reveal</button>
      </div>

      <div className="spacer" />
      <button className="btn-block" onClick={lock}>
        Lock wallet
      </button>
    </main>
  );
}

/**
 * Backup re-reveal behind re-auth (team-lead brief #4). Asks for the password, and
 * the SW re-decrypts the vault to return the mnemonic — the only post-creation path
 * that crosses the boundary, and only on this explicit request. No clipboard copy.
 */
function RevealBackup({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function reveal() {
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await client.getMnemonicForBackup(password);
      setMnemonic(res.mnemonic);
    } catch {
      // Wrong password or tamper — keep it generic.
      setError('Incorrect password.');
    } finally {
      setBusy(false);
    }
  }

  if (mnemonic) {
    const words = mnemonic.trim().split(/\s+/);
    return (
      <main className="screen">
        <div className="home-top">
          <h1>Recovery phrase</h1>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="warn-text">Keep these words private and offline.</p>
        <div className="word-grid">
          {words.map((w, i) => (
            <div className="word-cell" key={i}>
              <span className="word-num">{i + 1}</span>
              <span className="mono">{w}</span>
            </div>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn-block" onClick={onClose}>
          Done
        </button>
      </main>
    );
  }

  return (
    <main className="screen">
      <div className="home-top">
        <h1>Confirm password</h1>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <p className="subtitle">Enter your password to reveal your recovery phrase.</p>
      <label htmlFor="rpw">Password</label>
      <input
        id="rpw"
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && reveal()}
      />
      {error && <p className="error">{error}</p>}
      <div className="spacer" />
      <button className="btn-primary btn-block" disabled={!password || busy} onClick={reveal}>
        {busy ? 'Checking…' : 'Reveal phrase'}
      </button>
    </main>
  );
}
