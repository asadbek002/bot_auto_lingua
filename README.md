# Lingua Translation — AI Telegram Business Agent

AI agent that runs the Lingua Translation bureau's Telegram Business inbox: understands
client messages (Uzbek, Cyrillic or Latin), quotes prices, collects order data, verifies
payment screenshots, tracks orders in Google Sheets, and escalates anything risky to a
human. See `agent_profile.md` for the editable style/pricing/glossary guide and
`price_list.json` for authoritative prices.

## 1. Setup

```
npm install
copy .env.example .env   # then fill in the real values below
```

Required in `.env`:

- `TELEGRAM_BOT_TOKEN` — from @BotFather. **You must enable Secretary Mode** on the bot
  (BotFather → your bot → Business settings), then connect it under
  **Telegram app → Settings → Business → Chatbots** on the real business account. This is
  a manual, one-time step in the Telegram app UI — it cannot be scripted.
- `WORK_CHAT_ID` — your own chat id with the bot (send it any message, then check the
  bot's logs, or use @userinfobot). Receives escalations and deadline reminders and
  accepts `/exclude`, `/include`, `/list_excluded`.
- `LOG_CHANNEL_ID` — a channel/chat id where every outgoing agent reply is duplicated.
- `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` — provider keys.
- `GOOGLE_SERVICE_ACCOUNT_JSON` — path to a service-account keyfile (Google Cloud
  Console → IAM → Service Accounts → Keys). Share your target Google Sheet with the
  service account's `client_email` (do not make it public). Used for Sheets only.
- `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — **Drive uploads do not use
  the service account.** Service accounts have no Drive storage quota of their own on a
  plain Gmail (only Shared Drives / Google Workspace pool storage a service account can
  spend from) — confirmed by a real upload attempt during testing, which failed with
  "Service Accounts do not have storage quota". Instead, Drive uploads authenticate as
  your own Google account via OAuth:
  1. In the same Google Cloud project, go to APIs & Services → Credentials → Create
     Credentials → OAuth client ID → type **Desktop app**.
  2. Put its client ID/secret in `.env`.
  3. Run `npm run drive:authorize` once, open the printed URL, sign in with the Google
     account that should receive client files, and approve access. This saves a refresh
     token to `GOOGLE_OAUTH_TOKEN_PATH` (gitignored) — uploads then run non-interactively
     against that account's normal storage quota from then on.

## 2. Run

```
npm run build && npm start     # production
npm run dev                    # dev (tsx, no build step)
```

On startup the bot creates the `orders` / `excluded` / `price_list` tabs in the
configured Google Sheet if they don't exist yet, and starts long-polling for
`business_connection` / `business_message` updates plus an hourly deadline sweep.

## 3. Generating / refreshing `agent_profile.md`

The Telegram Bot API has no way to fetch chat history from before a business connection
existed, so training has two input sources:

```
# One-time bootstrap from real historical chats:
# In Telegram Desktop, open each client chat -> ... -> Export chat history -> JSON only.
# Drop the resulting result.json files into training_data/ (rename them if they collide).
npm run train -- --export-dir training_data --owner-name "Your Display Name In Telegram"

# Later, once the bot has been live a while, also fold in its own logs:
npm run train -- --export-dir training_data --live --owner-name "Your Display Name In Telegram"
```

This overwrites `agent_profile.md` — back up any manual edits first if you've customized
it by hand. `--owner-name` should match exactly how your name appears as `from` in the
export JSON, so messages are correctly labeled owner vs. client; without it, everything
is treated as a client message.

## 4. Process supervision (keep it running / auto-restart)

**pm2** (cross-platform):
```
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2-startup install   # or pm2-installer for native Windows boot start
```

**Windows-native alternative**: wrap `node dist/index.js` with
[NSSM](https://nssm.cc/) as a Windows service, or a Task Scheduler task set to run at
startup with "restart on failure" configured — either satisfies the same requirement
without installing pm2.

## 5. Escalation pause / resume

When the agent escalates (unclear request, discount/cancel ask, anything it isn't
confident about), that client is **paused**: the bot stops auto-replying to them (it
still logs whatever they send - nothing is lost) until a human resolves it, one of two
ways:

- **Способ А — reply in the work chat**: reply directly to the `⚠️ ESKALATSIYA` message
  with the resolution in your own words. The bot turns that into a natural client-facing
  reply (in the agent's usual tone, via `agent_profile.md`), sends it, and lifts the
  pause - accounting for anything the client wrote while paused.
- **Способ Б — `/resolved <order_id or client_id>`**: use this when you handled the
  client yourself outside the bot. It only lifts the pause - nothing is sent to the
  client. Anything they wrote while paused stays in history and is picked up next time
  the bot replies to them normally.

## 6. Testing

```
npm test
```

- `tests/unit/*` — pricing, order-id generation/matching, excluded-list gate, deadline
  status calculation, `/exclude` `/include` `/list_excluded` parsing. All pure, no
  network.
- `tests/integration/*` — full scripted order scenario, context-gap handling, voice
  message transcription, provider-failure handling, and persistence-across-restart, all
  against hand-written mocks for Telegram/Claude/Gemini/Sheets (see `tests/mocks/`).
  `voiceMessage.test.ts` will use a **real** Gemini call automatically if
  `GEMINI_API_KEY` is set in `.env`, otherwise it falls back to a mock.

### What is NOT tested end-to-end here

Telegram Business live messaging (an actual client sending a message to the connected
business account and the bot replying) requires the manual Secretary Mode setup above
plus a second real Telegram account — this is a live platform interaction I cannot
script or verify from this environment. Everything up to and including the Telegram
Bot API calls themselves (`sendMessage` with `business_connection_id`, `getFile`, etc.)
is implemented per the documented API, but the live "does Telegram actually deliver and
show the message correctly" step needs your manual verification once the business
connection is set up.
