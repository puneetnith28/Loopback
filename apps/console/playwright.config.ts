import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run against the PRODUCTION build (`vite build` + `vite preview`), so they prove what ships: no
 * design route, no demo fixtures. The read API is mocked per test with page.route() from test-fixtures/ (never
 * part of the build). The system Chrome is used (channel "chrome"); no browser download is required.
 */
const PORT = 4179;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    channel: "chrome",
    trace: "off",
    screenshot: "off",
    colorScheme: "dark",
  },
  projects: [
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } },
    { name: "mobile-390", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
