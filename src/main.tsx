import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthProvider } from './contexts/AuthContext';
import { AuthCallback } from './components/AuthCallback';
import { ToastProvider, ErrorBoundary, OfflineIndicator } from './components/ui/Feedback';
import { registerServiceWorker } from './services/pushService';
import './index.css';

// Single-page build with no router: branch on pathname so the OAuth and
// magic-link redirect lands somewhere that completes the session exchange.
const isAuthCallback = window.location.pathname.startsWith('/auth/callback');

// The service worker powers Web Push, makes the app installable, and lets it
// open without a signal. Registered in production only so dev reloads aren't
// intercepted by a stale worker.
//
// The "new version ready" pill that goes with it lives inside <main> in
// App.tsx, not out here: it sits above the map's own bottom-edge chrome and
// needs to be inside the same box the map is, so it clears the phone's tab
// bar without anyone hard-coding that bar's height.
if (import.meta.env.PROD) registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Root boundary is the last line of defence. Individual features have
        their own boundaries so one failure doesn't blank the app. */}
    <ErrorBoundary fallbackLabel="Wandrlust hit an unexpected error">
      <ToastProvider>
        <AuthProvider>
          {isAuthCallback ? <AuthCallback /> : <App />}
          <OfflineIndicator />
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>
);