import http from "http";
import URL from "url";
import type { Bot } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { sendBusinessMessage } from "./send.js";
import type { IncomingMessage } from "../pipeline/handleMessage.js";

let cachedMode: { mode: "crm" | "auto"; expiresAt: number } | null = null;

export async function getBotModeCached(): Promise<"crm" | "auto"> {
  const now = Date.now();
  if (cachedMode && cachedMode.expiresAt > now) {
    return cachedMode.mode;
  }

  try {
    const res = await fetch(`${env.LINGUA_MANAGER_API_URL}/bot/status`, {
      headers: {
        "X-Bot-Secret": env.LINGUA_MANAGER_API_KEY,
        "x-api-key": env.LINGUA_MANAGER_API_KEY,
      },
      signal: AbortSignal.timeout(3000),
    });

    if (res.ok) {
      const data = (await res.json()) as { status?: string };
      const mode = data.status === "auto" ? "auto" : "crm";
      cachedMode = { mode, expiresAt: now + 5000 };
      return mode;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch bot mode from CRM, falling back to env.BOT_MODE");
  }

  const fallback = env.BOT_MODE;
  cachedMode = { mode: fallback, expiresAt: now + 5000 };
  return fallback;
}

export async function forwardToCRM(
  incoming: IncomingMessage,
  botApi: Bot["api"]
): Promise<void> {
  const payload = {
    chat_id: String(incoming.clientChatId),
    business_connection_id: incoming.businessConnectionId,
    client_user_id: incoming.clientUserId,
    client_name: incoming.clientName,
    client_username: "",
    message_type: incoming.kind,
    text: incoming.text ?? incoming.caption ?? "",
    file_id: incoming.fileId ?? "",
    file_name: incoming.fileName ?? "",
    file_mime_type: incoming.fileMimeType ?? "",
    direction: "incoming",
    timestamp: Math.floor(Date.now() / 1000),
  };

  try {
    const res = await fetch(`${env.LINGUA_MANAGER_API_URL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bot-Secret": env.LINGUA_MANAGER_API_KEY,
        "x-api-key": env.LINGUA_MANAGER_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`CRM API HTTP ${res.status}: ${errText}`);
    }

    logger.info({ chatId: incoming.clientChatId }, "Successfully forwarded message to LinguaManager CRM");
  } catch (err) {
    logger.error({ err, chatId: incoming.clientChatId }, "Failed to forward message to CRM API");
    if (env.WORK_CHAT_ID) {
      await botApi
        .sendMessage(
          env.WORK_CHAT_ID,
          `⚠️ CRM ULANISH XATOLIGI\nClient: ${incoming.clientName} (${incoming.clientChatId})\nXabar CRM API ga uzatilmadi: ${err instanceof Error ? err.message : String(err)}`
        )
        .catch((sendErr) => logger.error({ sendErr }, "Work chat alert failed"));
    }
  }
}

export function startCRMWebhookServer(bot: Bot): http.Server {
  const server = http.createServer(async (req, res) => {
    const reqUrl = req.url ?? "/";
    const parsedUrl = URL.parse(reqUrl, true);
    const pathname = parsedUrl.pathname ?? "/";

    // Health check endpoint
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Proxy file streaming for media from Telegram API
    if (req.method === "GET" && pathname.startsWith("/crm-webhook/file")) {
      const fileId = (parsedUrl.query.file_id as string) || pathname.split("/").pop();
      if (!fileId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing file_id" }));
        return;
      }

      try {
        const file = await bot.api.getFile(fileId);
        if (!file.file_path) {
          throw new Error("No file_path returned from Telegram");
        }

        const telegramFileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const fileRes = await fetch(telegramFileUrl);

        if (!fileRes.ok || !fileRes.body) {
          res.writeHead(fileRes.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to download from Telegram" }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": fileRes.headers.get("content-type") || "application/octet-stream",
          "Content-Length": fileRes.headers.get("content-length") || "",
        });

        // Web ReadableStream to Node stream piping
        const reader = fileRes.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
        };
        await pump();
        return;
      } catch (err) {
        logger.error({ err, fileId }, "Error streaming file from Telegram API");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File download error" }));
        }
        return;
      }
    }

    // Reply webhook from CRM
    if (req.method === "POST" && pathname === "/crm-webhook/reply") {
      const apiKey = req.headers["x-api-key"];
      if (apiKey !== env.BOT_WEBHOOK_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      let bodyStr = "";
      req.on("data", (chunk) => {
        bodyStr += chunk;
      });

      req.on("end", async () => {
        try {
          const body = JSON.parse(bodyStr) as {
            client_chat_id: number | string;
            business_connection_id: string;
            text: string;
          };

          if (!body.client_chat_id || !body.business_connection_id || !body.text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required fields" }));
            return;
          }

          await sendBusinessMessage(
            bot,
            Number(body.client_chat_id),
            body.business_connection_id,
            body.text
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          logger.error({ err, bodyStr }, "Failed to process CRM reply webhook");
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      logger.warn({ port: env.BOT_WEBHOOK_PORT }, "CRM Webhook port already in use, reusing existing listener");
    } else {
      logger.error({ err }, "CRM Webhook server error");
    }
  });

  server.listen(env.BOT_WEBHOOK_PORT, () => {
    logger.info({ port: env.BOT_WEBHOOK_PORT }, "CRM Webhook HTTP server listening");
  });

  return server;
}
