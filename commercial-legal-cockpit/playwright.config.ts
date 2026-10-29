import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:3000" },
  webServer: {
    command: "bash scripts/start-reading-e2e.sh",
    url: "http://127.0.0.1:3000/reading",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
