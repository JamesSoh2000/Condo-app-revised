import { useQuery } from '@tanstack/react-query';

import { api } from '@/api/client';

/** The backend's build metadata (`GET /api/version`): the sample hook for the typed client (P1-07). */
export function useVersion() {
  return useQuery({ queryKey: ['version'], queryFn: () => api.get('/api/version') });
}
