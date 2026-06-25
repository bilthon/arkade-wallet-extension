import { useState } from 'react';
import { sendMessage } from '@/src/messaging';
import type { G0SpikeResult } from '@/src/spike';
import './App.css';

// ponytail: Phase-0 popup is a control panel for the two things Phase 0 must prove —
// the messaging chain (ping) and the G0 spike. Real wallet UI lands in Phase 1+.
function App() {
  const [pingResult, setPingResult] = useState<string>('');
  const [spike, setSpike] = useState<G0SpikeResult | null>(null);
  const [spikeBusy, setSpikeBusy] = useState(false);
  const [arkUrl, setArkUrl] = useState('http://localhost:7070');

  async function doPing() {
    try {
      const res = await sendMessage('ping', { echo: 'from-popup' });
      setPingResult(`pong @ ${new Date(res.timestamp).toISOString()} (echo: ${res.echo})`);
    } catch (err) {
      setPingResult(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function doSpike() {
    setSpikeBusy(true);
    setSpike(null);
    try {
      const res = await sendMessage('runG0Spike', { arkServerUrl: arkUrl });
      setSpike(res);
    } catch (err) {
      setSpike({
        arkServerUrl: arkUrl,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        stages: [{ stage: 'runG0Spike', status: 'error', detail: String(err) }],
        walletUsableInSW: false,
      });
    } finally {
      setSpikeBusy(false);
    }
  }

  return (
    <main style={{ width: 360, padding: 16, textAlign: 'left' }}>
      <h1 style={{ fontSize: 18 }}>Arkade Wallet — Phase 0</h1>

      <section style={{ marginTop: 12 }}>
        <button onClick={doPing}>Ping background</button>
        {pingResult && <p style={{ fontSize: 12 }}>{pingResult}</p>}
      </section>

      <section style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, display: 'block' }}>
          ark server URL
          <input
            value={arkUrl}
            onChange={(e) => setArkUrl(e.target.value)}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        <button onClick={doSpike} disabled={spikeBusy} style={{ marginTop: 8 }}>
          {spikeBusy ? 'Running G0 spike…' : 'Run G0 spike'}
        </button>
        {spike && (
          <ul style={{ fontSize: 12, marginTop: 8, paddingLeft: 16 }}>
            {spike.stages.map((s, i) => (
              <li key={i}>
                <strong>{s.stage}</strong>: {s.status}
                {s.detail ? ` — ${s.detail}` : ''}
              </li>
            ))}
            <li>
              <strong>walletUsableInSW</strong>: {String(spike.walletUsableInSW)}
            </li>
          </ul>
        )}
      </section>
    </main>
  );
}

export default App;
