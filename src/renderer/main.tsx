import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { KeyboardHelpHost } from './KeyboardHelp';

const root = document.getElementById('root');
if (!root) throw new Error('ChessPulse could not find its page root.');
createRoot(root).render(
  <StrictMode>
    <App />
    <KeyboardHelpHost />
  </StrictMode>,
);
