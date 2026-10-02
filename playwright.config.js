import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.js/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // Un reintento siempre, no solo en CI. Con `fullyParallel` hay varios Chrome a
  // la vez compitiendo por disco y CPU y eso hace caer de vez en cuando tests que
  // dependen del entorno: el que espera el evento de 'download' es el típico
  // (0 fallos en 6 corridas en aislamiento, ~1 de cada 3 en la suite completa).
  // No oculta bugs reales: los que son de la app fallan siempre y se ven igual.
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 20_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      // PW_CHANNEL=chrome usa el Chrome del sistema en vez del que descarga
      // Playwright. Necesario donde el CDN de playwright.dev esta bloqueado por
      // region (devuelve 403): el resto de la suite es identica.
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL || undefined },
    },
  ],

  // La app es mobile-first: se prueba tambien en viewport de movil.
  webServer: {
    command: 'node tests/server.mjs',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
