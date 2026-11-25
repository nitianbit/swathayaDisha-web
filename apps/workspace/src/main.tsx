import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@jansetu/api';
import { startLanguage } from '@jansetu/i18n';
import '@jansetu/ui/tokens.css';
import './styles.css';
import { App } from './App.tsx';
import { SessionProvider } from './session.tsx';
import { startApp } from './nativeShell.ts';
import { t } from './i18n/shell/index.ts';
import { shared } from '@jansetu/ui';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Staff data changes under other people's hands; refetch on focus, never retry a refusal.
      retry: (count, err) => count < 2 && (!(err instanceof ApiError) || err.status === 0 || err.status >= 500),
      staleTime: 15_000,
    },
    mutations: { retry: false },
  },
});

// '' = same origin: the dev server proxies /api to the backend. Release builds require an HTTPS origin (vite.config).
const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';

// N2: in the phone app the app starts only once the secure store is ready (a retry screen otherwise).
// Phase 6: the language (and its words) before the first render; English unless this app offers another.
const root = createRoot(document.getElementById('root')!);
void startLanguage('workspace').then(() => startApp(
  () => root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SessionProvider baseUrl={baseUrl}>
          <App />
        </SessionProvider>
      </QueryClientProvider>
    </StrictMode>,
  ),
  (retry) => root.render(
    <main className="login" role="alert">
      <p>{t('app.secureStorage')}</p>
      <button type="button" onClick={retry}>{shared('action.tryAgain')}</button>
    </main>,
  ),
));
