/**
 * Parses the argument of /exclude or /include: either "@username" or a raw numeric
 * user id. Returns null if the command has no usable argument.
 */
export function parseCommandTarget(argText) {
    const trimmed = argText.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith("@")) {
        const username = trimmed.slice(1);
        return username ? { type: "username", value: username } : null;
    }
    if (/^\d+$/.test(trimmed)) {
        return { type: "user_id", value: trimmed };
    }
    return null;
}
export function formatExcludedList(rows) {
    if (rows.length === 0)
        return "Istisnolar ro'yxati bo'sh.";
    const lines = rows.map((r, i) => `${i + 1}. ${r.username ? "@" + r.username : r.user_id} (id: ${r.user_id})` +
        (r.reason ? ` — ${r.reason}` : "") +
        (r.date_added ? ` [${r.date_added}]` : ""));
    return ["Istisnolar ro'yxati:", ...lines].join("\n");
}
//# sourceMappingURL=commands.js.map