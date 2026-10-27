import { defineConfig } from "@playwright/test";

const externalServer = process.env.NEXAAI_PLAYWRIGHT_EXTERNAL_SERVER === "1";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:4173", channel: "chrome", headless: true },
  webServer: externalServer ? undefined : {
    command:
      "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
