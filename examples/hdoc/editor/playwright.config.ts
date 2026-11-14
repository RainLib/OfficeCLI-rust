import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e', workers: 1, timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    viewport: { width: 1440, height: 1050 },
    launchOptions: process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
})
