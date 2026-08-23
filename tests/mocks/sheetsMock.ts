import type { OrderRecord } from "../../src/sheets/orders.js";
import type { HandleMessageDeps } from "../../src/pipeline/handleMessage.js";
import { computeNextOrderId } from "../../src/pipeline/orderId.js";

const OPEN_STATUSES = new Set(["new", "awaiting_prepayment", "in_progress", "ready", "overdue"]);

export interface FakeSheets {
  orders: OrderRecord[];
  excludedUserIds: Set<string>;
  ops: HandleMessageDeps["sheets"];
}

export function createFakeSheets(): FakeSheets {
  const orders: OrderRecord[] = [];
  const excludedUserIds = new Set<string>();

  const ops: HandleMessageDeps["sheets"] = {
    async isExcluded(userId) {
      return excludedUserIds.has(userId);
    },
    async findOpenOrdersForClient(userId) {
      return orders
        .map((order, i) => ({ order, rowIndex1Based: i + 2 }))
        .filter(({ order }) => order.client_user_id === userId && OPEN_STATUSES.has(order.status));
    },
    async findOrderById(orderId) {
      const idx = orders.findIndex((o) => o.order_id === orderId);
      if (idx === -1) return null;
      return { order: orders[idx]!, rowIndex1Based: idx + 2 };
    },
    async generateOrderId() {
      return computeNextOrderId(orders.map((o) => o.order_id));
    },
    async createOrder(order) {
      orders.push(order);
    },
    async updateOrder(rowIndex1Based, order) {
      const idx = rowIndex1Based - 2;
      orders[idx] = order;
    },
  };

  return { orders, excludedUserIds, ops };
}
