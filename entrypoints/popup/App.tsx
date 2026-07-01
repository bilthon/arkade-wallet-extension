import { useCallback, useEffect, useState } from 'react';
import { client, errorMessage } from './client';
import { Welcome } from './screens/Welcome';
import { CreatePassword } from './screens/CreatePassword';
import { Backup } from './screens/Backup';
import { Import } from './screens/Import';
import { Unlock } from './screens/Unlock';
import { WalletHome } from './screens/WalletHome';
import { Settings } from './screens/Settings';

/**
 * Popup router. No router library — a small route union keyed off the lock
 * state. On mount we ask the SW for `{ hasVault, unlocked }` and pick the
 * landing screen:
 *   no vault            → welcome (→ create / import)
 *   vault + locked      → unlock
 *   vault + unlocked    → wallet-home
 * Onboarding screens (create-password → backup) are transient routes that the
 * create flow drives explicitly before landing on home.
 */
type Route =
  | { name: 'loading' }
  | { name: 'welcome' }
  | { name: 'create' }
  | { name: 'backup'; mnemonic: string }
  | { name: 'import' }
  | { name: 'unlock' }
  | { name: 'home' }
  | { name: 'settings' };

function App() {
  const [route, setRoute] = useState<Route>({ name: 'loading' });
  const [bootError, setBootError] = useState<string>('');

  const refreshRoute = useCallback(async () => {
    try {
      const { hasVault, unlocked } = await client.getLockState();
      if (!hasVault) setRoute({ name: 'welcome' });
      else if (!unlocked) setRoute({ name: 'unlock' });
      else setRoute({ name: 'home' });
    } catch (err) {
      setBootError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refreshRoute();
  }, [refreshRoute]);

  if (bootError) {
    return (
      <main className="screen">
        <h1>Arkade Wallet</h1>
        <p className="error">Could not reach the wallet service: {bootError}</p>
        <button className="btn-block" onClick={() => location.reload()}>
          Retry
        </button>
      </main>
    );
  }

  switch (route.name) {
    case 'loading':
      return <main className="screen" />;

    case 'welcome':
      return (
        <Welcome
          onCreate={() => setRoute({ name: 'create' })}
          onImport={() => setRoute({ name: 'import' })}
        />
      );

    case 'create':
      return (
        <CreatePassword
          onCreated={(mnemonic) => setRoute({ name: 'backup', mnemonic })}
          onBack={() => setRoute({ name: 'welcome' })}
        />
      );

    case 'backup':
      return <Backup mnemonic={route.mnemonic} onDone={() => setRoute({ name: 'home' })} />;

    case 'import':
      return (
        <Import onImported={() => setRoute({ name: 'home' })} onBack={() => setRoute({ name: 'welcome' })} />
      );

    case 'unlock':
      return <Unlock onUnlocked={() => setRoute({ name: 'home' })} />;

    case 'home':
      return (
        <WalletHome
          onLocked={() => setRoute({ name: 'unlock' })}
          onSettings={() => setRoute({ name: 'settings' })}
        />
      );

    case 'settings':
      return (
        <Settings
          onBack={() => setRoute({ name: 'home' })}
          onLocked={() => setRoute({ name: 'unlock' })}
        />
      );
  }
}

export default App;
