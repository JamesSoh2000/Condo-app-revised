import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

import { AuthProvider } from '@/app/AuthProvider';
import { DevVersionFooter } from '@/app/DevVersionFooter';
import { queryClient } from '@/app/queryClient';
import { AppRoutes } from '@/app/routes';

/** The app shell (P2-06a): only the new auth API, no Base44 (ADR-0011). */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
      <DevVersionFooter />
    </QueryClientProvider>
  );
}
