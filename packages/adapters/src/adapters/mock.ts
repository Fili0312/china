import type {
  ProductCandidate,
  ProductDetails,
  SearchQuery,
} from "@china/shared";
import type { MarketplaceAdapter } from "../types";

/**
 * Adapter finto e deterministico: genera candidati plausibili senza rete.
 * Serve per sviluppare e testare l'intera pipeline (flow, retry, SSE,
 * preventivo) senza dipendere dallo scraping.
 */
export class MockAdapter implements MarketplaceAdapter {
  private hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  async search(query: SearchQuery): Promise<ProductCandidate[]> {
    const n = Math.min(query.maxResults ?? 5, 5);
    const base = this.hash(query.text);
    // Latenza simulata, così la UI mostra l'avanzamento in modo realistico.
    await new Promise((r) => setTimeout(r, 300 + (base % 700)));

    return Array.from({ length: n }, (_, i) => {
      const id = `mock-${base}-${i}`;
      return {
        marketplace: "mock",
        productId: id,
        title: `${query.text} — fornitore ${i + 1} (${query.language})`,
        url: `https://example.com/product/${id}`,
        imageUrl: `https://picsum.photos/seed/${id}/200/200`,
        price: {
          value: Math.round((0.5 + ((base + i * 97) % 2000) / 100) * 100) / 100,
          currency: "USD",
        },
        moq: [1, 10, 50, 100, 500][(base + i) % 5],
        snippet: null,
      };
    });
  }

  async getDetails(productId: string): Promise<ProductDetails> {
    const base = this.hash(productId);
    const price = Math.round((0.5 + (base % 2000) / 100) * 100) / 100;
    return {
      marketplace: "mock",
      productId,
      title: `Dettaglio ${productId}`,
      url: `https://example.com/product/${productId}`,
      imageUrl: `https://picsum.photos/seed/${productId}/400/400`,
      price: { value: price, currency: "USD" },
      moq: [1, 10, 50, 100, 500][base % 5],
      description: "Prodotto mock per sviluppo",
      images: [`https://picsum.photos/seed/${productId}/400/400`],
      priceTiers: [
        { minQty: 1, price: { value: price, currency: "USD" } },
        {
          minQty: 100,
          price: { value: Math.round(price * 0.85 * 100) / 100, currency: "USD" },
        },
      ],
      variants: [{ name: "colore", options: ["rosso", "blu", "nero"] }],
      attributes: { materiale: "plastica ABS" },
    };
  }
}
