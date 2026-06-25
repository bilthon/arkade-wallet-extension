import { useState } from 'react';
import { client, errorMessage } from '../client';
import { passwordStrength } from '../strength';

/**
 * Create-password screen. The password drives the at-rest KDF (crypto.ts); we show
 * a strength meter and require confirmation. On submit the SW generates the mnemonic
 * and returns it ONCE for the backup flow (the only non-reveal path that returns it).
 */
export function CreatePassword({
  onCreated,
  onBack,
}: {
  onCreated: (mnemonic: string) => void;
  onBack: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const strength = passwordStrength(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= 8 && password === confirm && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const { mnemonic } = await client.createWallet(password);
      onCreated(mnemonic);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <h1>Set a password</h1>
      <p className="subtitle">Encrypts your wallet on this device. Min 8 characters.</p>

      <label htmlFor="pw">Password</label>
      <input
        id="pw"
        type="password"
        value={password}
        autoFocus
        onChange={(e) => setPassword(e.target.value)}
      />
      <div className="strength" aria-hidden>
        {[1, 2, 3, 4].map((seg) => (
          <div key={seg} className={`strength-seg ${strength.score >= seg ? `on-${strength.score}` : ''}`} />
        ))}
      </div>
      <div className="strength-label">{strength.label}</div>

      <label htmlFor="pw2">Confirm password</label>
      <input
        id="pw2"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {mismatch && <p className="error">Passwords don't match.</p>}
      {error && <p className="error">{error}</p>}

      <div className="spacer" />

      <button className="btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
        {busy ? 'Creating…' : 'Create wallet'}
      </button>
      <button className="link-btn center" onClick={onBack} disabled={busy}>
        Back
      </button>
    </main>
  );
}
