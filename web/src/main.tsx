import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/views.css';

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from index.html');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
