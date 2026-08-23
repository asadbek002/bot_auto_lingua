import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRICE_LIST_PATH = path.resolve(__dirname, "../../price_list.json");
let cached = null;
let cachedPath = null;
export function loadPriceList(filePath = DEFAULT_PRICE_LIST_PATH) {
    if (cached && cachedPath === filePath)
        return cached;
    const raw = fs.readFileSync(filePath, "utf-8");
    cached = JSON.parse(raw);
    cachedPath = filePath;
    return cached;
}
export function clearPriceListCache() {
    cached = null;
    cachedPath = null;
}
export async function syncPriceListFromSheets(spreadsheetId) {
    const priceList = loadPriceList();
    if (!spreadsheetId)
        return priceList;
    try {
        const { getRows, SHEET_TABS } = await import("./client.js");
        const rows = await getRows(spreadsheetId, SHEET_TABS.priceList);
        const [, ...dataRows] = rows;
        for (const row of dataRows) {
            const [serviceType, , priceStr] = row;
            const price = Number(priceStr);
            if (!serviceType || isNaN(price))
                continue;
            if (serviceType === "translation_standard_to_english") {
                priceList.translation.standard_to_english = price;
            }
            else if (serviceType === "translation_notarized_to_english") {
                priceList.translation.notarized_to_english = price;
            }
            else if (serviceType === "translation_soliq_qaytarish_to_english") {
                priceList.translation.soliq_qaytarish_to_english = price;
            }
            else if (serviceType.startsWith("apostille_")) {
                const docType = serviceType.replace("apostille_", "");
                priceList.apostille.by_document_type[docType] = price;
            }
        }
    }
    catch {
        // If sheets call fails, preserve current cached priceList safely
    }
    return priceList;
}
export function priceTranslationUnit(priceList, tier, purpose) {
    if (purpose === "soliq_qaytarish") {
        return priceList.translation.soliq_qaytarish_to_english;
    }
    return tier === "notarized"
        ? priceList.translation.notarized_to_english
        : priceList.translation.standard_to_english;
}
export function priceApostilleUnit(priceList, docType) {
    const known = priceList.apostille.by_document_type[docType];
    if (known !== undefined)
        return known;
    return priceList.apostille.by_document_type["boshqa"] ?? 0;
}
export function calculatePrice(priceList, items, prepaymentPercent) {
    const priced = items.map((item) => {
        let unitPrice;
        if (item.serviceType === "translation") {
            unitPrice = priceTranslationUnit(priceList, item.translationTier ?? "standard", item.translationPurpose ?? "other");
        }
        else {
            unitPrice = priceApostilleUnit(priceList, item.apostilleDocType ?? "boshqa");
        }
        return { ...item, unitPrice, totalPrice: unitPrice * item.quantity };
    });
    const total = priced.reduce((sum, item) => sum + item.totalPrice, 0);
    const prepayment = Math.round((total * prepaymentPercent) / 100);
    return { items: priced, total, prepayment };
}
//# sourceMappingURL=priceList.js.map