import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@jansetu/api';
import '@jansetu/ui/tokens.css';
import './styles.css';
import { App } from './App.tsx';
import { SessionProvider } from './session.tsx';
import { startApp } from './nativeShell.ts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => count < 2 && (!(err instanceof ApiError) || err.status === 0 || err.status >= 500),
      staleTime: 30_000,
    },
    mutations: { retry: false },
  },
});

// '' = same origin (the dev server proxies /api). Release builds require an HTTPS origin (vite.config).
const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';

// N2: in the phone app the app starts only once the secure store is ready (a retry screen otherwise).
const root = createRoot(document.getElementById('root')!);
void startApp(
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
      <p>The app could not open this phone's secure storage, which keeps you signed in safely.</p>
      <button type="button" onClick={retry}>Try again</button>
    </main>,
  ),
);
