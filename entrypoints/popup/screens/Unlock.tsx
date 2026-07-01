import { useState } from 'react';
import { client } from '../client';

/**
 * Unlock screen (Strict posture). After an SW kill the seed is gone, so
 * the next sensitive action lands here. A wrong password leaves the wallet locked.
 */
export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await client.unlock(password);
      onUnlocked();
    } catch {
      setError('Incorrect password.');
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <h1>Welcome back</h1>
      <p className="subtitle">Enter your password to unlock your wallet.</p>

      <label htmlFor="upw">Password</label>
      <input
        id="upw"
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && <p className="error">{error}</p>}

      <div className="spacer" />
      <button className="btn-primary btn-block" disabled={!password || busy} onClick={submit}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
    </main>
  );
}
