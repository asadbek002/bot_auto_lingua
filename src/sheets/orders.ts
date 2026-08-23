import { appendRows, getRows, updateRow, SHEET_TABS, ORDERS_HEADER } from "./client.js";
import { computeNextOrderId } from "../pipeline/orderId.js";

export type OrderStatus =
  | "new"
  | "awaiting_prepayment"
  | "in_progress"
  | "ready"
  | "overdue"
  | "delivered"
  | "cancelled";

export interface OrderRecord {
  order_id: string;
  client_user_id: string;
  client_name: string;
  phone: string;
  service_type: string;
  documents_description: string;
  document_files_links: string;
  source_lang: string;
  target_lang: string;
  urgency: string;
  quantity: string;
  unit_price: string;
  total_price: string;
  prepayment_status: string;
  payment_screenshot_link: string;
  order_date: string;
  deadline_date: string;
  status: string;
  delivery_method: string;
  notes: string;
}

const COL_INDEX = Object.fromEntries(
  ORDERS_HEADER.map((h, i) => [h, i])
) as Record<(typeof ORDERS_HEADER)[number], number>;

function rowToOrder(row: string[]): OrderRecord {
  const get = (key: (typeof ORDERS_HEADER)[number]) => row[COL_INDEX[key]] ?? "";
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

function orderToRow(order: OrderRecord): string[] {
  return ORDERS_HEADER.map((h) => order[h] ?? "");
}

const OPEN_STATUSES: ReadonlySet<string> = new Set([
  "new",
  "awaiting_prepayment",
  "in_progress",
  "ready",
  "overdue",
]);

export async function getAllOrders(
  spreadsheetId: string
): Promise<{ order: OrderRecord; rowIndex1Based: number }[]> {
  const rows = await getRows(spreadsheetId, SHEET_TABS.orders);
  const [, ...dataRows] = rows;
  return dataRows.map((row, i) => ({ order: rowToOrder(row), rowIndex1Based: i + 2 }));
}

export async function findOpenOrdersForClient(
  spreadsheetId: string,
  clientUserId: string
): Promise<{ order: OrderRecord; rowIndex1Based: number }[]> {
  const all = await getAllOrders(spreadsheetId);
  return all.filter(
    ({ order }) =>
      order.client_user_id === clientUserId && OPEN_STATUSES.has(order.status)
  );
}

export async function findOrderById(
  spreadsheetId: string,
  orderId: string
): Promise<{ order: OrderRecord; rowIndex1Based: number } | null> {
  const all = await getAllOrders(spreadsheetId);
  return all.find(({ order }) => order.order_id === orderId) ?? null;
}

export async function generateOrderId(
  spreadsheetId: string,
  now: Date = new Date()
): Promise<string> {
  const all = await getAllOrders(spreadsheetId);
  return computeNextOrderId(
    all.map(({ order }) => order.order_id),
    now
  );
}

export async function createOrder(
  spreadsheetId: string,
  order: OrderRecord
): Promise<void> {
  await appendRows(spreadsheetId, SHEET_TABS.orders, [orderToRow(order)]);
}

export async function updateOrder(
  spreadsheetId: string,
  rowIndex1Based: number,
  order: OrderRecord
): Promise<void> {
  await updateRow(spreadsheetId, SHEET_TABS.orders, rowIndex1Based, orderToRow(order));
}

/**
 * Computes order status purely from order_date + turnaround, without ever asking the
 * model to guess. Rule #7 in the ТЗ: agent calculates and states status itself.
 */
export function computeStatus(
  orderDateIso: string,
  turnaroundDays: number,
  now: Date = new Date()
): { deadlineDate: Date; isOverdue: boolean; daysRemaining: number } {
  const orderDate = new Date(orderDateIso);
  const deadlineDate = addWorkingDays(orderDate, turnaroundDays);
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.ceil((deadlineDate.getTime() - now.getTime()) / msPerDay);
  return { deadlineDate, isOverdue: daysRemaining < 0, daysRemaining };
}

function addWorkingDays(start: Date, days: number): Date {
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
