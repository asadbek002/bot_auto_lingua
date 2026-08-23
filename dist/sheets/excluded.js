import { appendRows, getRows, SHEET_TABS, EXCLUDED_HEADER } from "./client.js";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";
const COL_INDEX = Object.fromEntries(EXCLUDED_HEADER.map((h, i) => [h, i]));
function rowToExcluded(row) {
    const get = (key) => row[COL_INDEX[key]] ?? "";
    return {
        user_id: get("user_id"),
        username: get("username"),
        added_by: get("added_by"),
        date_added: get("date_added"),
        reason: get("reason"),
    };
}
export async function listExcluded(spreadsheetId) {
    const rows = await getRows(spreadsheetId, SHEET_TABS.excluded);
    const [, ...dataRows] = rows;
    return dataRows.map(rowToExcluded).filter((r) => r.user_id);
}
export async function isExcluded(spreadsheetId, userId) {
    const list = await listExcluded(spreadsheetId);
    return list.some((r) => r.user_id === userId);
}
export async function addExcluded(spreadsheetId, record) {
    const already = await isExcluded(spreadsheetId, record.user_id);
    if (already)
        return;
    await appendRows(spreadsheetId, SHEET_TABS.excluded, [
        [record.user_id, record.username, record.added_by, record.date_added, record.reason],
    ]);
}
export async function removeExcluded(spreadsheetId, userId) {
    const rows = await getRows(spreadsheetId, SHEET_TABS.excluded);
    const [header, ...dataRows] = rows;
    const idx = dataRows.findIndex((row) => row[COL_INDEX.user_id] === userId);
    if (idx === -1)
        return false;
    const remaining = dataRows.filter((_, i) => i !== idx);
    const { getSheetsClient } = await import("./client.js");
    const sheets = await getSheetsClient();
    await withRetry(() => sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `${SHEET_TABS.excluded}!A2:Z`,
    }), {
        attempts: 3,
        onRetry: (err, attempt) => logger.warn({ err, attempt, label: "values.clear(excluded)" }, "Google Sheets call retry"),
    });
    if (remaining.length > 0) {
        await appendRows(spreadsheetId, SHEET_TABS.excluded, remaining);
    }
    void header;
    return true;
}
//# sourceMappingURL=excluded.js.map