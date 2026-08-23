import { appendRows, getRows, updateRow, SHEET_TABS, ORDERS_HEADER } from "./client.js";
import { computeNextOrderId } from "../pipeline/orderId.js";
const COL_INDEX = Object.fromEntries(ORDERS_HEADER.map((h, i) => [h, i]));
function rowToOrder(row) {
    const get = (key) => row[COL_INDEX[key]] ?? "";
    return {
        order_id: get("order_id"),
        client_user_id: get("client_user_id"),
        client_name: get("client_name"),
        phone: get("phone"),
        service_type: get("service_type"),
        documents_description: get("documents_description"),
        document_files_links: get("document_files_links"),
        source_lang: get("source_lang"),
        target_lang: get("target_lang"),
        urgency: get("urgency"),
        quantity: get("quantity"),
        unit_price: get("unit_price"),
        total_price: get("total_price"),
        prepayment_status: get("prepayment_status"),
        payment_screenshot_link: get("payment_screenshot_link"),
        order_date: get("order_date"),
        deadline_date: get("deadline_date"),
        status: get("status"),
        delivery_method: get("delivery_method"),
        notes: get("notes"),
    };
}
function orderToRow(order) {
    return ORDERS_HEADER.map((h) => order[h] ?? "");
}
const OPEN_STATUSES = new Set([
    "new",
    "awaiting_prepayment",
    "in_progress",
    "ready",
    "overdue",
]);
export async function getAllOrders(spreadsheetId) {
    const rows = await getRows(spreadsheetId, SHEET_TABS.orders);
    const [, ...dataRows] = rows;
    return dataRows.map((row, i) => ({ order: rowToOrder(row), rowIndex1Based: i + 2 }));
}
export async function findOpenOrdersForClient(spreadsheetId, clientUserId) {
    const all = await getAllOrders(spreadsheetId);
    return all.filter(({ order }) => order.client_user_id === clientUserId && OPEN_STATUSES.has(order.status));
}
export async function findOrderById(spreadsheetId, orderId) {
    const all = await getAllOrders(spreadsheetId);
    return all.find(({ order }) => order.order_id === orderId) ?? null;
}
export async function generateOrderId(spreadsheetId, now = new Date()) {
    const all = await getAllOrders(spreadsheetId);
    return computeNextOrderId(all.map(({ order }) => order.order_id), now);
}
export async function createOrder(spreadsheetId, order) {
    await appendRows(spreadsheetId, SHEET_TABS.orders, [orderToRow(order)]);
}
export async function updateOrder(spreadsheetId, rowIndex1Based, order) {
    await updateRow(spreadsheetId, SHEET_TABS.orders, rowIndex1Based, orderToRow(order));
}
/**
 * Computes order status purely from order_date + turnaround, without ever asking the
 * model to guess. Rule #7 in the ТЗ: agent calculates and states status itself.
 */
export function computeStatus(orderDateIso, turnaroundDays, now = new Date()) {
    const orderDate = new Date(orderDateIso);
    const deadlineDate = addWorkingDays(orderDate, turnaroundDays);
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysRemaining = Math.ceil((deadlineDate.getTime() - now.getTime()) / msPerDay);
    return { deadlineDate, isOverdue: daysRemaining < 0, daysRemaining };
}
function addWorkingDays(start, days) {
    const result = new Date(start);
    let added = 0;
    while (added < days) {
        result.setDate(result.getDate() + 1);
        const dayOfWeek = result.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            added += 1;
        }
    }
    return result;
}
//# sourceMappingURL=orders.js.map