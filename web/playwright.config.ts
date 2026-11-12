import { defineConfig, devices } from '@playwright/test';

// Runs against a production build: run `npm run build` first.
// The tests replace the route, search and map-style requests, so no BRouter, Nominatim or map tiles are needed.
const PORT = 3100;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: { command: `npx next start -p ${PORT}`, url: `http://localhost:${PORT}`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
