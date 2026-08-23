import { Store } from "../../state/store.js";
/**
 * Reads the bot's own accumulated conversation logs (once it's been live a while) as a
 * second training source, using the same normalized shape as the Telegram Desktop
 * export adapter so train.ts can treat both sources identically.
 */
export function loadLiveConversations(stateFilePath) {
    const store = new Store(stateFilePath);
    const all = store.getAllConversations();
    return Object.entries(all).map(([chatKey, records]) => ({
        source: `live:${chatKey}`,
        chatName: chatKey,
        messages: records.map((r) => ({
            from: r.role === "agent" ? "owner" : "client",
            text: r.text,
            date: new Date(r.timestamp).toISOString(),
        })),
    }));
}
//# sourceMappingURL=liveLogAdapter.js.map