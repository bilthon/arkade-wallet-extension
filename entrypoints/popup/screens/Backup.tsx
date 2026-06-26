import { useMemo, useState } from 'react';

/**
 * Backup flow (PLAN.md §5, team-lead brief #4): tap-to-reveal the mnemonic, then
 * confirm a few random words to prove it was written down. NO clipboard auto-copy —
 * the seed phrase is never placed on the clipboard by us. The wallet is already
 * created and unlocked at this point; this gates the transition to home.
 */
export function Backup({ mnemonic, onDone }: { mnemonic: string; onDone: () => void }) {
  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic]);
  const [revealed, setRevealed] = useState(false);
  const [stage, setStage] = useState<'view' | 'confirm'>('view');

  // Pick 3 distinct random word positions to verify (1-based for display).
  const checkIndexes = useMemo(() => pickRandom(words.length, Math.min(3, words.length)), [words.length]);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  const allCorrect = checkIndexes.every(
    (i) => (answers[i] ?? '').trim().toLowerCase() === words[i].toLowerCase(),
  );

  if (stage === 'view') {
    return (
      <main className="screen">
        <h1>Back up your wallet</h1>
        <p className="subtitle">
          Write these {words.length} words down in order and keep them offline. They are the only
          way to recover your funds. Anyone with them controls your wallet.
        </p>

        {!revealed ? (
          <div className="reveal-cover" onClick={() => setRevealed(true)} role="button" tabIndex={0}>
            <strong>Tap to reveal</strong>
            <p className="row-sub" style={{ marginTop: 6 }}>
              Make sure no one is watching your screen.
            </p>
          </div>
        ) : (
          <div className="word-grid">
            {words.map((w, i) => (
              <div className="word-cell" key={i}>
                <span className="word-num">{i + 1}</span>
                <span className="mono">{w}</span>
              </div>
            ))}
          </div>
        )}

        <div className="spacer" />
        <button
          className="btn-primary btn-block"
          disabled={!revealed}
          onClick={() => setStage('confirm')}
        >
          I've written it down
        </button>
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>Confirm your backup</h1>
      <p className="subtitle">Enter the requested words to confirm you saved them.</p>

      {checkIndexes.map((i) => (
        <div key={i}>
          <label htmlFor={`w${i}`}>Word #{i + 1}</label>
          <input
            id={`w${i}`}
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            value={answers[i] ?? ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
          />
        </div>
      ))}

      <div className="spacer" />
      <button className="btn-primary btn-block" disabled={!allCorrect} onClick={onDone}>
        Finish
      </button>
      <button className="link-btn center" onClick={() => setStage('view')}>
        Show words again
      </button>
    </main>
  );
}

/** Pick `count` distinct random indexes in [0, length). CSPRNG only — the wallet
 * holds the "no Math.random anywhere" invariant (PLAN.md §7 spirit). */
function pickRandom(length: number, count: number): number[] {
  const pool = Array.from({ length }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

/** Unbiased random integer in [0, max) via `crypto.getRandomValues` (rejection
 * sampling to drop the modulo bias). max is small here (word count), so the loop
 * effectively never re-rolls. */
function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  let x = 0;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}
