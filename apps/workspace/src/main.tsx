import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@jansetu/api';
import '@jansetu/ui/tokens.css';
import './styles.css';
import { App } from './App.tsx';
import { SessionProvider } from './session.tsx';
import { installNativeShell } from './nativeShell.ts';

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

// N2: in the phone app the secure store must be in place before the session restores; in a browser this is a no-op.
void installNativeShell().catch(() => undefined).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SessionProvider baseUrl={baseUrl}>
          <App />
        </SessionProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
});
