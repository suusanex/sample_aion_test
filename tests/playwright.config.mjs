import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "app.spec.mjs",
  use: { baseURL: "http://127.0.0.1:5188", headless: true },
  webServer: { command: "dotnet run --project ../src/AionTest.Web --no-launch-profile --urls http://127.0.0.1:5188", url: "http://127.0.0.1:5188", reuseExistingServer: !process.env.CI },
});
