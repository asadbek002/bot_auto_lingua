export const DEFAULT_ESCALATION_STUB = "Hozircha aniqlashtirib olaman, tez orada javob qilamiz.";
export function formatEscalationNotice(params) {
    return [
        "⚠️ ESKALATSIYA",
        `Mijoz: ${params.clientName} (id: ${params.clientUserId})`,
        `Sabab: ${params.reason}`,
        `Oxirgi xabar: ${params.lastMessage}`,
    ].join("\n");
}
export function formatPaidOrderNotice(params) {
    return [
        "✅ Yangi buyurtma (to'lov qabul qilindi)",
        `Order ID: ${params.orderId}`,
        `Mijoz: ${params.clientName}`,
        `Summa: ${params.total.toLocaleString("ru-RU")} ${params.currency}`,
    ].join("\n");
}
//# sourceMappingURL=escalation.js.map