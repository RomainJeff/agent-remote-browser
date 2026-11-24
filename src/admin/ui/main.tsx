import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { ApiError } from '@/lib/api';
import { sessionQuery } from '@/lib/session';
import { createAppRouter } from '@/router';
import './styles.css';

// A 401 anywhere means the session ended: forget it and let the routes send the admin to sign-in.
const signedOut = (e: unknown) => {
  if (!(e instanceof ApiError) || e.status !== 401) return;
  queryClient.setQueryData(sessionQuery.queryKey, null);
  void router.invalidate();
};
const queryClient = new QueryClient({ queryCache: new QueryCache({ onError: signedOut }), mutationCache: new MutationCache({ onError: signedOut }) });
const router = createAppRouter(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>
  </StrictMode>,
);
