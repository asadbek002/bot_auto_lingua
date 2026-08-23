import dotenv from "dotenv";
import { z } from "zod";
dotenv.config({ quiet: true });
const envSchema = z.object({
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    WORK_CHAT_ID: z.string().optional().default(""),
    LOG_CHANNEL_ID: z.string().optional().default(""),
    ANTHROPIC_API_KEY: z.string().optional().default(""),
    CLAUDE_MODEL: z.string().default("claude-3-5-sonnet-latest"),
    GEMINI_API_KEY: z.string().optional().default(""),
    GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
    GEMINI_MODEL_LITE: z.string().default("gemini-2.0-flash"),
    GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default("./google-service-account.json"),
    GOOGLE_SHEETS_SPREADSHEET_ID: z.string().optional().default(""),
    GOOGLE_DRIVE_ROOT_FOLDER_ID: z.string().optional().default(""),
    // Drive uploads use OAuth as a real Google account instead of the service account,
    // because service accounts have no Drive storage quota of their own on a plain Gmail
    // (only Shared Drives / Workspace pool storage a service account can spend from).
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional().default(""),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional().default(""),
    GOOGLE_OAUTH_TOKEN_PATH: z.string().default("./google-oauth-token.json"),
    STANDARD_TURNAROUND_DAYS: z.coerce.number().int().positive().default(6),
    PREPAYMENT_PERCENT: z.coerce.number().min(0).max(100).default(50),
    LOG_LEVEL: z.string().default("info"),
    STATE_FILE_PATH: z.string().default("./data/state.json"),
    LOG_FILE_PATH: z.string().default("./logs/agent.log"),
    DEADLINE_CHECK_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
    AUTO_TRAIN_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
});
function loadEnv() {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n");
        throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    return parsed.data;
}
export const env = loadEnv();
export function requireForLiveMode(keys) {
    return keys.filter((k) => !env[k]);
}
//# sourceMappingURL=env.js.map