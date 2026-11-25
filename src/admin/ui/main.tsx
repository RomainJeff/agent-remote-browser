import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { ConfirmHost } from '@/components/confirm';
import { Toaster } from '@/components/ui/sonner';
import { setApiHooks } from '@/lib/api';
import { sessionQuery } from '@/lib/session';
import { createAppRouter } from '@/router';
import './styles.css';

const queryClient = new QueryClient();
const router = createAppRouter(queryClient);
// The session ended: forget it and let the routes send the admin to sign-in.
setApiHooks({ signedOut: () => { queryClient.setQueryData(sessionQuery.queryKey, null); void router.invalidate(); } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}><RouterProvider router={router} /><ConfirmHost /><Toaster /></QueryClientProvider>
  </StrictMode>,
);
