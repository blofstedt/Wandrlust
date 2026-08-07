import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthProvider } from './contexts/AuthContext';
import { AuthCallback } from './components/AuthCallback';
import { ToastProvider, ErrorBoundary, OfflineIndicator } from './components/ui/Feedback';
import { UpdatePrompt } from './components/UpdatePrompt';
import { registerServiceWorker } from './services/pushService';
import './index.css';

// Single-page build with no router: branch on pathname so the OAuth and
// magic-link redirect lands somewhere that completes the session exchange.
const isAuthCallback = window.location.pathname.startsWith('/auth/callback');

// The service worker powers Web Push, makes the app installable, and lets it
// open without a signal. Registered in production only so dev reloads aren't
// intercepted by a stale worker.
const hasServiceWorker = import.meta.env.PROD;
if (hasServiceWorker) registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Root boundary is the last line of defence. Individual features have
        their own boundaries so one failure doesn't blank the app. */}
    <ErrorBoundary fallbackLabel="Wandrlust hit an unexpected error">
      <ToastProvider>
        <AuthProvider>
          {isAuthCallback ? <AuthCallback /> : <App />}
          <OfflineIndicator />
          {/* Only where a worker actually exists — in dev there is none, and
              waiting on one that never arrives would hang forever. */}
          {hasServiceWorker && <UpdatePrompt />}
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>
);