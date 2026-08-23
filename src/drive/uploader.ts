import fs from "node:fs";
import { Readable } from "node:stream";
import { google, drive_v3 } from "googleapis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

let driveClient: drive_v3.Drive | null = null;

async function driveCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, {
    attempts: 3,
    onRetry: (err, attempt) => logger.warn({ err, attempt, label }, "Google Drive call retry"),
  });
}

/**
 * Drive uploads authenticate as a real Google account via OAuth (not the Sheets
 * service account), because service accounts have no Drive storage quota of their own
 * outside of Shared Drives / Workspace - see src/drive/authorize.ts for the one-time
 * setup that produces GOOGLE_OAUTH_TOKEN_PATH.
 */
async function getDriveClient(): Promise<drive_v3.Drive> {
  if (driveClient) return driveClient;
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not configured in .env"
    );
  }
  if (!fs.existsSync(env.GOOGLE_OAUTH_TOKEN_PATH)) {
    throw new Error(
      `No OAuth token found at ${env.GOOGLE_OAUTH_TOKEN_PATH}. Run "npm run drive:authorize" once to authorize Drive access.`
    );
  }
  const tokens = JSON.parse(fs.readFileSync(env.GOOGLE_OAUTH_TOKEN_PATH, "utf-8"));
  const auth = new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials(tokens);
  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

async function findOrCreateFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string
): Promise<string> {
  const escapedName = name.replace(/'/g, "\\'");
  const res = await driveCall(`files.list(${name})`, () => drive.files.list({
    q: `'${parentId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
  }));
  const existing = res.data.files?.[0];
  if (existing?.id) return existing.id;

  const created = await driveCall(`files.create(folder:${name})`, () => drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  }));
  if (!created.data.id) throw new Error(`Failed to create Drive folder "${name}"`);
  return created.data.id;
}

export interface UploadResult {
  fileId: string;
  webViewLink: string;
}

/**
 * Uploads a file buffer to /clients/{clientUserId}/{orderId}/{fileName}, creating the
 * folder chain as needed. Returns a link to store in Google Sheets.
 */
export async function uploadClientFile(
  clientUserId: string,
  orderId: string,
  fileName: string,
  buffer: Buffer,
  mimeType: string
): Promise<UploadResult> {
  const drive = await getDriveClient();
  if (!env.GOOGLE_DRIVE_ROOT_FOLDER_ID) {
    throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured");
  }

  const clientsFolderId = await findOrCreateFolder(
    drive,
    "clients",
    env.GOOGLE_DRIVE_ROOT_FOLDER_ID
  );
  const clientFolderId = await findOrCreateFolder(drive, clientUserId, clientsFolderId);
  const orderFolderId = await findOrCreateFolder(drive, orderId, clientFolderId);

  const created = await driveCall(`files.create(file:${fileName})`, () => drive.files.create({
    requestBody: { name: fileName, parents: [orderFolderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id, webViewLink",
  }));

  if (!created.data.id) throw new Error("Drive upload did not return a file id");
  return {
    fileId: created.data.id,
    webViewLink: created.data.webViewLink ?? `https://drive.google.com/file/d/${created.data.id}/view`,
  };
}
