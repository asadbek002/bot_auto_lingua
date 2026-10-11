import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // `npm test` .env siz ham ishlasin (env.ts TELEGRAM_BOT_TOKEN talab qiladi)
    env: { TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "test:token" },
  },
});
