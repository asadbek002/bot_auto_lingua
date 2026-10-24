import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { Store } from "./state/store.js";
import { loadPriceList, syncPriceListFromSheets } from "./sheets/priceList.js";
import { loadAgentProfile, callAgent, resolveWithStaffInput } from "./ai/claude.js";
import { transcribeVoice, extractDocument, extractReceipt } from "./ai/gemini.js";
import { uploadClientFile } from "./drive/uploader.js";
import { ensureTabsExist } from "./sheets/client.js";
import { findOpenOrdersForClient, findOrderById, generateOrderId, createOrder, updateOrder, } from "./sheets/orders.js";
import { isExcluded } from "./sheets/excluded.js";
import { createBot } from "./telegram/bot.js";
import { startDeadlineScheduler } from "./scheduler/deadlineReminder.js";
import { startAutoTrainScheduler } from "./scheduler/autoTrainScheduler.js";
async function main() {
    logger.info("Starting Lingua Translation AI agent...");
    const store = new Store(env.STATE_FILE_PATH);
    let priceList = loadPriceList();
    if (env.GOOGLE_SHEETS_SPREADSHEET_ID) {
        try {
            await ensureTabsExist(env.GOOGLE_SHEETS_SPREADSHEET_ID);
            priceList = await syncPriceListFromSheets(env.GOOGLE_SHEETS_SPREADSHEET_ID);
            logger.info("Google Sheets tabs verified/created & price list synced");
        }
        catch (err) {
            logger.error({ err }, "Failed to ensure Google Sheets tabs exist or sync price list");
        }
    }
    else {
        logger.warn("GOOGLE_SHEETS_SPREADSHEET_ID not set - Sheets features disabled");
    }
    const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const staticDeps = {
        spreadsheetId,
        sheetsOps: {
            isExcluded: (userId) => isExcluded(spreadsheetId, userId),
            findOpenOrdersForClient: (userId) => findOpenOrdersForClient(spreadsheetId, userId),
            findOrderById: (orderId) => findOrderById(spreadsheetId, orderId),
            generateOrderId: () => generateOrderId(spreadsheetId),
            createOrder: (order) => createOrder(spreadsheetId, order),
            updateOrder: (rowIndex, order) => updateOrder(spreadsheetId, rowIndex, order),
        },
        aiOps: {
            transcribeVoice,
            extractDocument,
            extractReceipt,
            callAgent,
            resolveWithStaffInput,
        },
        driveOps: {
            uploadClientFile,
        },
        store,
        priceList,
        get agentProfile() {
            return loadAgentProfile();
        },
        prepaymentPercent: env.PREPAYMENT_PERCENT,
        standardTurnaroundDays: env.STANDARD_TURNAROUND_DAYS,
    };
    const bot = createBot(env.TELEGRAM_BOT_TOKEN, staticDeps);
    if (env.WORK_CHAT_ID) {
        startDeadlineScheduler({
            spreadsheetId,
            store,
            standardTurnaroundDays: env.STANDARD_TURNAROUND_DAYS,
            notifyWorkChat: (text) => bot.api.sendMessage(env.WORK_CHAT_ID, text).then(() => undefined),
        }, env.DEADLINE_CHECK_INTERVAL_MINUTES);
    }
    else {
        logger.warn("WORK_CHAT_ID not set - deadline reminders and escalation notices disabled");
    }
    startAutoTrainScheduler(env.AUTO_TRAIN_INTERVAL_HOURS);
    bot.catch((err) => {
        logger.error({ err }, "Unhandled bot error");
    });
    await bot.start({
    allowed_updates: ["message","business_message","business_connection","edited_business_message","deleted_business_messages","callback_query"],
        onStart: () => logger.info("bot polling started"),
    });
}
main().catch((err) => {
    logger.error({ err }, "Fatal error during startup");
    process.exit(1);
});
//# sourceMappingURL=index.js.map