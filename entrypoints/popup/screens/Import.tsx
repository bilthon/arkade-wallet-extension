import { useState } from 'react';
import { client, errorMessage } from '../client';
import { passwordStrength } from '../strength';

/**
 * Import flow: paste a mnemonic + set a new password. The SW validates the mnemonic
 * (`validateMnemonic`) and encrypts it under the password before persisting; an
 * invalid phrase or empty-vault check failure throws and is surfaced inline.
 */
export function Import({ onImported, onBack }: { onImported: () => void; onBack: () => void }) {
  const [mnemonic, setMnemonic] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const strength = passwordStrength(password);
  const wordCount = mnemonic.trim() ? mnemonic.trim().split(/\s+/).length : 0;
  const plausible = wordCount === 12 || wordCount === 24;
  const canSubmit = plausible && password.length >= 8 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await client.importWallet(mnemonic.trim().replace(/\s+/g, ' '), password);
      onImported();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <h1>Import a wallet</h1>
      <p className="subtitle">Paste your 12 or 24-word recovery phrase.</p>

      <label htmlFor="mn">Recovery phrase</label>
      <textarea
        id="mn"
        value={mnemonic}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => setMnemonic(e.target.value)}
        placeholder="word1 word2 word3 …"
      />
      {wordCount > 0 && !plausible && (
        <p className="row-sub">{wordCount} words — expected 12 or 24.</p>
      )}

      <label htmlFor="ipw">New password</label>
      <input
        id="ipw"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {password.length > 0 && <div className="strength-label">{strength.label}</div>}

      {error && <p className="error">{error}</p>}

      <div className="spacer" />
      <button className="btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
        {busy ? 'Importing…' : 'Import wallet'}
      </button>
      <button className="link-btn center" onClick={onBack} disabled={busy}>
        Back
      </button>
    </main>
  );
}
