import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { env } from "../config/env.js";
const logDir = path.dirname(env.LOG_FILE_PATH);
fs.mkdirSync(logDir, { recursive: true });
export const logger = pino({
    level: env.LOG_LEVEL,
    redact: {
        paths: [
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "TELEGRAM_BOT_TOKEN",
            "*.ANTHROPIC_API_KEY",
            "*.GEMINI_API_KEY",
            "*.TELEGRAM_BOT_TOKEN",
            "req.headers.authorization",
            "headers.authorization",
        ],
        censor: "[REDACTED]",
    },
}, pino.transport({
    targets: [
        {
            target: "pino-pretty",
            level: env.LOG_LEVEL,
            options: { colorize: true, translateTime: "SYS:standard" },
        },
        {
            target: "pino/file",
            level: env.LOG_LEVEL,
            options: { destination: env.LOG_FILE_PATH, mkdir: true },
        },
    ],
}));
//# sourceMappingURL=logger.js.map