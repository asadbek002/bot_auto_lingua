function datePart(now) {
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}
/**
 * Pure order-id generator: ORD-YYYYMMDD-NNNN, sequence based on how many orders already
 * exist for that date, collision-checked and bumped against the full existing-id set.
 */
export function computeNextOrderId(existingIds, now = new Date()) {
    const today = datePart(now);
    const existing = new Set(existingIds);
    const sameDayCount = existingIds.filter((id) => id.includes(today)).length;
    let seq = sameDayCount + 1;
    let candidate = `ORD-${today}-${String(seq).padStart(4, "0")}`;
    while (existing.has(candidate)) {
        seq += 1;
        candidate = `ORD-${today}-${String(seq).padStart(4, "0")}`;
    }
    return candidate;
}
/**
 * Decides whether an incoming order-relevant message continues an existing open order
 * or should become a new one. Claude may optionally hint an existingOrderId when the
 * conversation clearly continues a specific open order; we only trust that hint if it
 * actually matches one of the client's currently open orders (never trust a hallucinated
 * id blindly).
 */
export function resolveTargetOrder(existingOrderIdHint, openOrders) {
    if (!existingOrderIdHint)
        return null;
    return openOrders.find((o) => o.order_id === existingOrderIdHint) ?? null;
}
//# sourceMappingURL=orderId.js.map