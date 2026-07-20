import type {
  ProductCandidate,
  ProductDetails,
  SearchLanguage,
  SearchQuery,
} from "@china/shared";

/**
 * Principio architetturale: ogni marketplace è isolato dietro questa
 * interfaccia comune. Il resto della piattaforma non sa (e non deve sapere)
 * come un adapter ottiene i dati — scraping Playwright, API ufficiale, ecc.
 */
export interface MarketplaceAdapter {
  search(query: SearchQuery): Promise<ProductCandidate[]>;
  getDetails(productId: string): Promise<ProductDetails>;
}

/**
 * Metadati che accompagnano ogni adapter nel registry (additivi rispetto
 * all'interfaccia core: non toccano il contratto search/getDetails).
 */
export interface AdapterDescriptor {
  /** Nome canonico usato in MARKETPLACES e salvato in DB. */
  name: string;
  /** Lingue di ricerca supportate: il worker invia la query corrispondente. */
  languages: SearchLanguage[];
  create(): MarketplaceAdapter;
}
