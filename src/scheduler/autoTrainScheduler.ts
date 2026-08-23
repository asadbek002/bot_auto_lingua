import cron from "node-cron";
import { runTraining } from "../train/train.js";
import { logger } from "../utils/logger.js";

export function startAutoTrainScheduler(intervalHours: number): void {
  // Run once every N hours
  const cronExpr = `0 */${Math.max(1, Math.min(23, intervalHours))} * * *`;
  cron.schedule(cronExpr, async () => {
    logger.info("Starting scheduled automatic training sweep on live conversations...");
    try {
      await runTraining({
        exportDir: "training_data",
        includeLive: true,
        provider: "gemini",
      });
      logger.info("Scheduled live training sweep completed successfully.");
    } catch (err) {
      logger.error({ err }, "Scheduled live training sweep failed");
    }
  });
  logger.info({ intervalHours, cronExpr }, "Auto-training scheduler started (using free Gemini AI)");
}
