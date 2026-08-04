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

// Service worker powers Web Push. Registered in production only so dev
// reloads aren't intercepted by a stale worker.
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
