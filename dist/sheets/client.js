import fs from "node:fs";
import { google } from "googleapis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
import { loadPriceList } from "./priceList.js";
export const SHEET_TABS = {
    orders: "orders",
    excluded: "excluded",
    priceList: "price_list",
};
export const ORDERS_HEADER = [
    "order_id",
    "client_user_id",
    "client_name",
    "phone",
    "service_type",
    "documents_description",
    "document_files_links",
    "source_lang",
    "target_lang",
    "urgency",
    "quantity",
    "unit_price",
    "total_price",
    "prepayment_status",
    "payment_screenshot_link",
    "order_date",
    "deadline_date",
    "status",
    "delivery_method",
    "notes",
];
export const EXCLUDED_HEADER = [
    "user_id",
    "username",
    "added_by",
    "date_added",
    "reason",
];
export const PRICE_LIST_HEADER = ["service_type", "unit", "price"];
let sheetsClient = null;
async function sheetsCall(label, fn) {
    return withRetry(fn, {
        attempts: 3,
        onRetry: (err, attempt) => logger.warn({ err, attempt, label }, "Google Sheets call retry"),
    });
}
function hasServiceAccount() {
    return fs.existsSync(env.GOOGLE_SERVICE_ACCOUNT_JSON);
}
export async function getSheetsClient() {
    if (sheetsClient)
        return sheetsClient;
    if (!hasServiceAccount()) {
        throw new Error(`Google service account keyfile not found at ${env.GOOGLE_SERVICE_ACCOUNT_JSON}. ` +
            "Download it from Google Cloud Console and share the target Sheet + Drive folder with its client_email.");
    }
    const auth = new google.auth.GoogleAuth({
        keyFile: env.GOOGLE_SERVICE_ACCOUNT_JSON,
        scopes: [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive",
        ],
    });
    sheetsClient = google.sheets({ version: "v4", auth });
    return sheetsClient;
}
async function getExistingSheetTitles(sheets, spreadsheetId) {
    const res = await sheetsCall("spreadsheets.get", () => sheets.spreadsheets.get({ spreadsheetId }));
    const titles = (res.data.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((t) => Boolean(t));
    return new Set(titles);
}
function flattenPriceListToRows() {
    const priceList = loadPriceList();
    const rows = [];
    rows.push([
        "translation_standard_to_english",
        priceList.translation.unit,
        String(priceList.translation.standard_to_english),
    ]);
    rows.push([
        "translation_notarized_to_english",
        priceList.translation.unit,
        String(priceList.translation.notarized_to_english),
    ]);
    rows.push([
        "translation_soliq_qaytarish_to_english",
        priceList.translation.unit,
        String(priceList.translation.soliq_qaytarish_to_english),
    ]);
    for (const [docType, price] of Object.entries(priceList.apostille.by_document_type)) {
        rows.push([`apostille_${docType}`, priceList.apostille.unit, String(price)]);
    }
    return rows;
}
export async function ensureTabsExist(spreadsheetId) {
    const sheets = await getSheetsClient();
    const existing = await getExistingSheetTitles(sheets, spreadsheetId);
    const missing = Object.values(SHEET_TABS).filter((t) => !existing.has(t));
    if (missing.length > 0) {
        await sheetsCall("spreadsheets.batchUpdate(add missing tabs)", () => sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
            },
        }));
        logger.info({ missing }, "Created missing Google Sheets tabs");
    }
    await ensureHeaderRow(sheets, spreadsheetId, SHEET_TABS.orders, [...ORDERS_HEADER]);
    await ensureHeaderRow(sheets, spreadsheetId, SHEET_TABS.excluded, [...EXCLUDED_HEADER]);
    await ensureHeaderRow(sheets, spreadsheetId, SHEET_TABS.priceList, [...PRICE_LIST_HEADER]);
    const priceRows = await getRows(spreadsheetId, SHEET_TABS.priceList);
    if (priceRows.length <= 1) {
        await appendRows(spreadsheetId, SHEET_TABS.priceList, flattenPriceListToRows());
    }
}
async function ensureHeaderRow(sheets, spreadsheetId, tab, header) {
    const res = await sheetsCall(`values.get(${tab} header)`, () => sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${tab}!1:1`,
    }));
    const firstRow = res.data.values?.[0];
    if (!firstRow || firstRow.length === 0) {
        await sheetsCall(`values.update(${tab} header)`, () => sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${tab}!A1`,
            valueInputOption: "RAW",
            requestBody: { values: [header] },
        }));
    }
}
export async function getRows(spreadsheetId, tab) {
    const sheets = await getSheetsClient();
    const res = await sheetsCall(`values.get(${tab})`, () => sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${tab}!A:Z`,
    }));
    return (res.data.values ?? []);
}
export async function appendRows(spreadsheetId, tab, rows) {
    if (rows.length === 0)
        return;
    const sheets = await getSheetsClient();
    await sheetsCall(`values.append(${tab})`, () => sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tab}!A:Z`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: rows },
    }));
}
export async function updateRow(spreadsheetId, tab, rowIndex1Based, row) {
    const sheets = await getSheetsClient();
    await sheetsCall(`values.update(${tab})`, () => sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A${rowIndex1Based}`,
        valueInputOption: "RAW",
        requestBody: { values: [row] },
    }));
}
//# sourceMappingURL=client.js.map