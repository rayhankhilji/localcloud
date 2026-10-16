import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Hello from a tunnel 👋</h1>
      <p>
        Served from <code>{location.origin}</code>. Edit <code>src/App.jsx</code> and save — the change appears
        here without a reload, and the counter keeps its value (HMR over the localcloud websocket).
      </p>
      <button onClick={() => setCount((n) => n + 1)}>clicked {count} times</button>
    </main>
  );
}
