import fs from "node:fs";
import http from "node:http";
import { google } from "googleapis";
import { env } from "../config/env.js";
const PORT = 51789;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/drive"];
/**
 * One-time interactive authorization: run `npm run drive:authorize`, open the printed
 * URL in a browser, sign in with the Google account whose Drive should receive client
 * files, and grant access. The refresh token is saved to GOOGLE_OAUTH_TOKEN_PATH so
 * future uploads (src/drive/uploader.ts) run non-interactively as that account, which
 * has real Drive storage quota (unlike the Sheets service account).
 */
async function main() {
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
        console.error("Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env.\n" +
            "Create an OAuth Client ID (type: Desktop app) in the same Google Cloud project " +
            "as your service account (APIs & Services -> Credentials -> Create Credentials -> " +
            "OAuth client ID), then put its client id/secret in .env and re-run this script.");
        process.exit(1);
    }
    const oauth2Client = new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET, REDIRECT_URI);
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
    });
    console.log("\n1. Open this URL in a browser and sign in with the Google account that");
    console.log("   should receive uploaded client files (needs real Drive storage quota):\n");
    console.log(authUrl);
    console.log("\n2. Approve access. You'll be redirected to localhost and this script will");
    console.log("   pick up the result automatically.\n");
    const code = await waitForAuthCode();
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
        console.error("No refresh_token was returned. This usually means the account already granted " +
            "access before - go to https://myaccount.google.com/permissions, remove access " +
            "for this app, and run `npm run drive:authorize` again.");
        process.exit(1);
    }
    fs.writeFileSync(env.GOOGLE_OAUTH_TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
    console.log(`\nSaved OAuth tokens to ${env.GOOGLE_OAUTH_TOKEN_PATH}. Drive uploads are ready.`);
}
function waitForAuthCode() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (!req.url)
                return;
            const url = new URL(req.url, `http://localhost:${PORT}`);
            const code = url.searchParams.get("code");
            const error = url.searchParams.get("error");
            if (error) {
                res.end("Authorization failed - you can close this window.");
                server.close();
                reject(new Error(`OAuth error: ${error}`));
                return;
            }
            if (code) {
                res.end("Authorization successful - you can close this window and return to the terminal.");
                server.close();
                resolve(code);
            }
        });
        server.listen(PORT);
    });
}
main().catch((err) => {
    console.error("Authorization failed:", err.message);
    process.exit(1);
});
//# sourceMappingURL=authorize.js.map