import { describe, it, expect } from "vitest";
import { calculatePrice, type PriceList, type LineItem } from "../../src/sheets/priceList.js";

const priceList: PriceList = {
  currency: "UZS",
  translation: {
    unit: "list",
    standard_to_english: 60000,
    notarized_to_english: 100000,
    soliq_qaytarish_to_english: 50000,
  },
  apostille: {
    unit: "document",
    by_document_type: {
      diplom: 250000,
      guvohnoma: 200000,
      boshqa: 220000,
    },
  },
};

describe("calculatePrice", () => {
  it("prices a single standard translation line item", () => {
    const items: LineItem[] = [
      { serviceType: "translation", quantity: 3, translationTier: "standard" },
    ];
    const result = calculatePrice(priceList, items, 50);
    expect(result.items[0]!.unitPrice).toBe(60000);
    expect(result.total).toBe(180000);
    expect(result.prepayment).toBe(90000);
  });

  it("prices notarized translation at the higher tier", () => {
    const items: LineItem[] = [
      { serviceType: "translation", quantity: 2, translationTier: "notarized" },
    ];
    const result = calculatePrice(priceList, items, 50);
    expect(result.total).toBe(200000);
  });

  it("applies the soliq tariff ONLY when purpose is explicitly soliq_qaytarish", () => {
    const items: LineItem[] = [
      {
        serviceType: "translation",
        quantity: 4,
        translationTier: "standard",
        translationPurpose: "soliq_qaytarish",
      },
    ];
    const result = calculatePrice(priceList, items, 50);
    expect(result.items[0]!.unitPrice).toBe(50000);
    expect(result.total).toBe(200000);
  });

  it("falls back to normal tariff when purpose is 'other' or unset, never guessing", () => {
    const ambiguous: LineItem[] = [
      { serviceType: "translation", quantity: 1, translationTier: "standard", translationPurpose: "other" },
    ];
    const unset: LineItem[] = [
      { serviceType: "translation", quantity: 1, translationTier: "standard" },
    ];
    expect(calculatePrice(priceList, ambiguous, 50).items[0]!.unitPrice).toBe(60000);
    expect(calculatePrice(priceList, unset, 50).items[0]!.unitPrice).toBe(60000);
  });

  it("prices apostille per document by document type, not per page", () => {
    const items: LineItem[] = [
      { serviceType: "apostille", quantity: 2, apostilleDocType: "diplom" },
    ];
    const result = calculatePrice(priceList, items, 50);
    expect(result.items[0]!.unitPrice).toBe(250000);
    expect(result.total).toBe(500000);
  });

  it("falls back to 'boshqa' pricing for an unknown apostille document type", () => {
    const items: LineItem[] = [
      { serviceType: "apostille", quantity: 1, apostilleDocType: "unknown_type" },
    ];
    const result = calculatePrice(priceList, items, 50);
    expect(result.items[0]!.unitPrice).toBe(220000);
  });

  it("combines apostille and translation as separate line items in one order", () => {
    const items: LineItem[] = [
      { serviceType: "translation", quantity: 2, translationTier: "standard" },
      { serviceType: "apostille", quantity: 1, apostilleDocType: "guvohnoma" },
    ];
    const result = calculatePrice(priceList, items, 50);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2 * 60000 + 200000);
    expect(result.prepayment).toBe(Math.round(result.total * 0.5));
  });

  it("rounds prepayment to the nearest whole unit", () => {
    const items: LineItem[] = [
      { serviceType: "translation", quantity: 1, translationTier: "standard" },
    ];
    const result = calculatePrice(priceList, items, 33);
    expect(result.prepayment).toBe(Math.round(60000 * 0.33));
  });
});
