export function Welcome({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <main className="screen">
      <h1>Arkade Wallet</h1>
      <p className="subtitle">A Bitcoin L2 wallet for the Arkade network.</p>

      <div className="spacer" />

      <button className="btn-primary btn-block" onClick={onCreate}>
        Create a new wallet
      </button>
      <div style={{ height: 8 }} />
      <button className="btn-block" onClick={onImport}>
        Import an existing wallet
      </button>
    </main>
  );
}
