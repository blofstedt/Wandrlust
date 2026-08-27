import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthProvider } from './contexts/AuthContext';
import { AuthCallback } from './components/AuthCallback';
import { LandingPage } from './components/LandingPage';
import { LegalPage } from './components/LegalPage';
import { ToastProvider, ErrorBoundary, OfflineIndicator } from './components/ui/Feedback';
import { registerServiceWorker } from './services/pushService';
import './index.css';

/**
 * Single-page build with no router: branch on pathname.
 *
 * `/auth/callback` has to exist so the OAuth and magic-link redirect lands
 * somewhere that completes the session exchange. The other three exist
 * because Google's OAuth branding review will not verify a sign-in button
 * without a home page, a privacy policy and terms of service, each at a plain
 * public URL on the same domain with nobody signed in — see PublicPage.tsx.
 *
 * `vercel.json` already rewrites everything that is not `/api/` to this same
 * index.html, so a cold visit to /privacy serves the app shell and this
 * branch decides what it renders. Nothing needed adding at the edge.
 *
 * FOUR BRANCHES IS THE LIMIT. A fifth means a router.
 */
const path = window.location.pathname.replace(/\/+$/, '') || '/';

const isAuthCallback = path.startsWith('/auth/callback');
const publicPage: 'home' | 'privacy' | 'terms' | null =
  path === '/home' ? 'home'
  : path === '/privacy' ? 'privacy'
  : path === '/terms' ? 'terms'
  : null;

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
          {isAuthCallback ? (
            <AuthCallback />
          ) : publicPage === 'home' ? (
            <LandingPage />
          ) : publicPage ? (
            <LegalPage kind={publicPage} />
          ) : (
            <App />
          )}
          <OfflineIndicator />
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>
);