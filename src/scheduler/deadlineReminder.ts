import cron from "node-cron";
import { getAllOrders, computeStatus } from "../sheets/orders.js";
import type { Store } from "../state/store.js";
import { logger } from "../utils/logger.js";

export interface DeadlineReminderDeps {
  spreadsheetId: string;
  store: Store;
  standardTurnaroundDays: number;
  notifyWorkChat(text: string): Promise<void>;
}

const OPEN_STATUSES: ReadonlySet<string> = new Set([
  "new",
  "awaiting_prepayment",
  "in_progress",
  "ready",
]);

export async function checkDeadlines(deps: DeadlineReminderDeps, now: Date = new Date()): Promise<void> {
  const todayIso = now.toISOString().slice(0, 10);
  const all = await getAllOrders(deps.spreadsheetId);

  for (const { order } of all) {
    if (!OPEN_STATUSES.has(order.status)) continue;
    if (!order.order_date) continue;

    const { isOverdue, daysRemaining } = computeStatus(
      order.order_date,
      deps.standardTurnaroundDays,
      now
    );

    const dueTomorrow = daysRemaining === 1;
    if (!isOverdue && !dueTomorrow) continue;
    if (deps.store.hasBeenNotifiedToday(order.order_id, todayIso)) continue;

    const label = isOverdue ? "MUDDATI O'TIB KETDI" : "Ertaga muddati tugaydi";
    await deps.notifyWorkChat(
      [
        `⏰ ${label}`,
        `Order ID: ${order.order_id}`,
        `Mijoz: ${order.client_name}`,
        `Deadline: ${order.deadline_date}`,
      ].join("\n")
    );
    deps.store.markDeadlineNotified(order.order_id, todayIso);
  }
}

export function startDeadlineScheduler(
  deps: DeadlineReminderDeps,
  intervalMinutes: number
): void {
  const cronExpr = `*/${Math.max(1, Math.min(59, intervalMinutes))} * * * *`;
  cron.schedule(cronExpr, () => {
    checkDeadlines(deps).catch((err) => logger.error({ err }, "Deadline check failed"));
  });
  logger.info({ cronExpr }, "Deadline reminder scheduler started");
}
