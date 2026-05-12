// Side-panel React root. Placeholder for the queue UI; the
// extension-engineer fills this in next.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return (
    <main>
      <h1>SBA Helper</h1>
      <p>Pending request queue loads here.</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('side panel root element missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
