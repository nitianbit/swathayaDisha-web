import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@jansetu/api';
import '@jansetu/ui/tokens.css';
import './styles.css';
import { App } from './App.tsx';
import { SessionProvider } from './session.tsx';

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider baseUrl={baseUrl}>
        <App />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
