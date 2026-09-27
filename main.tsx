import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app/globals.css';
import { AuthGate } from './components/auth-gate';

createRoot(document.getElementById('root')!).render(<StrictMode><AuthGate /></StrictMode>);
