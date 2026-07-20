import type { ProductSearchResult, ProductSort } from "@china/shared";

/**
 * Provider di ricerca prodotti via API esterna (OTAPI oggi; 1688/AliExpress
 * in futuro). Distinto da MarketplaceAdapter (packages/adapters, Playwright):
 * quella pipeline è accantonata ma intatta, questa è la modalità test API.
 */
export interface ProductSearchProvider {
  readonly name: string;
  search(params: {
    query: string;
    framePosition: number;
    frameSize: number;
    sort: ProductSort;
  }): Promise<ProductSearchResult>;
}

/** Chiave/configurazione mancante lato server. */
export class ProviderConfigError extends Error {}

/** L'API esterna ha risposto con errore (HTTP o ErrorCode applicativo). */
export class ProviderUpstreamError extends Error {}

/** L'API esterna non ha risposto entro il timeout. */
export class ProviderTimeoutError extends Error {}

/** Capacità del processo esaurita: il client può riprovare più tardi. */
export class ProviderBusyError extends Error {}
