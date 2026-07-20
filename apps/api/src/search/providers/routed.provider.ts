import type { ProductSearchResult, ProductSort } from "@china/shared";
import type { ProductSearchProvider } from "./provider";

/**
 * Sceglie la via da cui interrogare un marketplace.
 *
 * Alibaba e AliExpress hanno due strade possibili: l'API Piloterr, che
 * funziona ma consuma crediti, e l'adapter Playwright, gratuito ma bloccato
 * dal captcha su questo IP. La scelta dipende solo dalla presenza della
 * chiave, quindi va decisa a ogni chiamata: la chiave può comparire nel .env
 * dopo l'avvio del processo.
 *
 * Non c'è ripiego automatico in caso di errore: se Piloterr risponde male, il
 * motivo va mostrato all'utente, non nascosto dietro un secondo tentativo su
 * una fonte che sappiamo già bloccata.
 */

interface ConfigurableProvider extends ProductSearchProvider {
  readonly isConfigured: boolean;
  getHealth?(): Record<string, unknown>;
}

export class RoutedSearchProvider implements ProductSearchProvider {
  constructor(
    readonly name: string,
    private readonly preferred: ConfigurableProvider,
    private readonly fallback: ProductSearchProvider
  ) {}

  private pick(): ProductSearchProvider {
    return this.preferred.isConfigured ? this.preferred : this.fallback;
  }

  getHealth(): Record<string, unknown> {
    const active = this.pick();
    const health = (
      active as ProductSearchProvider & {
        getHealth?: () => Record<string, unknown>;
      }
    ).getHealth?.();
    return {
      route: this.preferred.isConfigured ? "piloterr" : "browser",
      ...(health ?? {}),
    };
  }

  search(params: {
    query: string;
    framePosition: number;
    frameSize: number;
    sort: ProductSort;
  }): Promise<ProductSearchResult> {
    return this.pick().search(params);
  }
}
