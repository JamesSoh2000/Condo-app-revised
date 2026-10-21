import { test as setup } from '@playwright/test';

import { apiLogin, PERSONAS, type Persona, storageStatePath } from '../helpers/auth';

// Each shared persona logs in once per run; journeys reuse the saved cookies (the login rate limits count every
// attempt per email, P2-05).
for (const persona of Object.keys(PERSONAS) as Persona[]) {
  setup(`log in as ${persona}`, async ({ request, baseURL }) => {
    await apiLogin(request, baseURL!, PERSONAS[persona]);
    await request.storageState({ path: storageStatePath(persona) });
  });
}
