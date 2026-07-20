import assert from "node:assert/strict";
import test from "node:test";
import {
  PiloterrClient,
  type PiloterrFetch,
} from "./providers/piloterr.client";
import {
  parseCurrency,
  parseMinOrder,
  PiloterrSearchProvider,
} from "./providers/piloterr.provider";
import {
  ProviderBusyError,
  ProviderConfigError,
  ProviderTimeoutError,
  ProviderUpstreamError,
} from "./providers/provider";
import { RoutedSearchProvider } from "./providers/routed.provider";

/** `fetch` finto: registra le chiamate e risponde ciò che gli si dice. */
function stubFetch(
  responses: Array<{ status?: number; body: unknown | string }>
): { fetch: PiloterrFetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let index = 0;
  const fetch: PiloterrFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      text: async () =>
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body),
    };
  };
  return { fetch, calls };
}

const ALIBABA_PAGE = {
  results: [
    {
      product_id: "1600123456789",
      title: "Anti-static ESD chair with lift",
      listing_url: "https://www.alibaba.com/product-detail/x_1600123456789.html",
      image_url: "https://s.alicdn.com/x.jpg",
      price_text: "US $38.00-$52.00",
      price_min: 38,
      price_max: 52,
      min_order: "10 pieces",
      category: "Office Chairs",
      seller_name: "Foshan Kingtop Co., Ltd.",
      seller_id: "kingtop",
      sold_count: 420,
    },
  ],
  pagination: { page: 1, per_page: 20, total_results: 1500, total_pages: 75, next: true },
};

test("senza chiave configurata il client non chiama la rete", async () => {
  const { fetch, calls } = stubFetch([{ body: ALIBABA_PAGE }]);
  const client = new PiloterrClient({ apiKey: "", fetchImpl: fetch });

  assert.equal(client.isConfigured, false);
  await assert.rejects(
    () => client.get("/v2/alibaba/search", { query: "x" }),
    ProviderConfigError
  );
  assert.equal(calls.length, 0, "nessuna chiamata deve partire senza chiave");
});

test("la chiave viaggia nell'header e mai nell'URL", async () => {
  const { fetch, calls } = stubFetch([{ body: ALIBABA_PAGE }]);
  const client = new PiloterrClient({ apiKey: "segreto-abc", fetchImpl: fetch });

  await client.get("/v2/alibaba/search", { query: "sedia", page: 1 });

  assert.equal(calls[0]!.headers["x-api-key"], "segreto-abc");
  assert.ok(
    !calls[0]!.url.includes("segreto-abc"),
    "la chiave non deve finire in query string: i proxy registrano gli URL"
  );
  assert.match(calls[0]!.url, /^https:\/\/api\.piloterr\.com\/v2\/alibaba\/search\?/);
});

test("la chiave non compare mai nei messaggi d'errore", async () => {
  const { fetch } = stubFetch([
    { status: 500, body: 'upstream failed for key segreto-abc while parsing' },
  ]);
  const client = new PiloterrClient({ apiKey: "segreto-abc", fetchImpl: fetch });

  await assert.rejects(
    () => client.get("/v2/alibaba/search", { query: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderUpstreamError);
      assert.ok(
        !error.message.includes("segreto-abc"),
        `messaggio non ripulito: ${error.message}`
      );
      assert.match(error.message, /\*\*\*/);
      return true;
    }
  );
});

test("una risposta identica non consuma un secondo credito", async () => {
  const { fetch, calls } = stubFetch([{ body: ALIBABA_PAGE }]);
  const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch });

  await client.get("/v2/alibaba/search", { query: "sedia", page: 1 });
  await client.get("/v2/alibaba/search", { query: "sedia", page: 1 });

  assert.equal(calls.length, 1, "la seconda richiesta deve arrivare dalla cache");
  const usage = client.getUsage();
  assert.equal(usage.calls, 1);
  assert.equal(usage.cacheHits, 1);
  assert.equal(usage.creditsSpent, 1, "la ricerca Alibaba costa 1 credito");
});

test("il costo in crediti segue l'endpoint chiamato", async () => {
  const { fetch } = stubFetch([{ body: { results: [] } }]);
  const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch });

  await client.get("/v2/aliexpress/search", { query: "power bank" });
  assert.equal(client.getUsage().creditsSpent, 2, "AliExpress costa 2 crediti");
});

test("il tetto di spesa blocca le chiamate oltre il limite", async () => {
  const { fetch, calls } = stubFetch([{ body: ALIBABA_PAGE }]);
  const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch, maxCalls: 1 });

  await client.get("/v2/alibaba/search", { query: "uno" });
  await assert.rejects(
    () => client.get("/v2/alibaba/search", { query: "due" }),
    ProviderConfigError
  );
  assert.equal(calls.length, 1);
  assert.equal(client.getUsage().blockedByBudget, 1);
});

test("gli stati HTTP diventano errori tipizzati", async () => {
  const cases: Array<[number, unknown]> = [
    [401, ProviderConfigError],
    [402, ProviderUpstreamError],
    [429, ProviderBusyError],
    [500, ProviderUpstreamError],
  ];
  for (const [status, expected] of cases) {
    const { fetch } = stubFetch([{ status, body: { error: "no" } }]);
    const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch, cacheTtlMs: 0 });
    await assert.rejects(
      () => client.get("/v2/alibaba/search", { query: "x" }),
      expected as never,
      `stato ${status}`
    );
  }
});

test("un errore 4xx non viene conteggiato come credito speso", async () => {
  const { fetch } = stubFetch([{ status: 401, body: {} }]);
  const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch });
  await assert.rejects(() => client.get("/v2/alibaba/search", { query: "x" }));
  assert.equal(client.getUsage().creditsSpent, 0);
});

test("una risposta che non arriva entro il timeout è un errore di timeout", async () => {
  const fetch: PiloterrFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new Error("The operation was aborted"))
      );
    });
  const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch, timeoutMs: 20 });
  await assert.rejects(
    () => client.get("/v2/alibaba/search", { query: "x" }),
    ProviderTimeoutError
  );
});

test("la ricerca Alibaba viene normalizzata nel contratto della piattaforma", async () => {
  const { fetch } = stubFetch([{ body: ALIBABA_PAGE }]);
  const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch });
  const provider = new PiloterrSearchProvider({ engine: "alibaba", client });

  const result = await provider.search({
    query: "esd chair",
    framePosition: 0,
    frameSize: 10,
    sort: "default",
  });

  assert.equal(result.provider, "alibaba");
  assert.equal(result.totalCount, 1500);
  const [item] = result.items;
  assert.equal(item?.id, "1600123456789");
  assert.equal(item?.originalPrice, 38, "si usa il minimo della forbice");
  assert.equal(item?.currency, "USD");
  assert.equal(item?.moq, 10, "il MOQ va estratto da “10 pieces”");
  assert.equal(item?.vendorName, "Foshan Kingtop Co., Ltd.");
  assert.equal(item?.totalSales, 420);
  assert.equal(item?.productUrl, ALIBABA_PAGE.results[0]!.listing_url);
});

test("i risultati senza id o senza indirizzo vengono scartati", async () => {
  const { fetch } = stubFetch([
    {
      body: {
        results: [
          { title: "senza id", listing_url: "https://x.it/1" },
          { product_id: "2", title: "senza url" },
          { product_id: "3", title: "buono", listing_url: "https://x.it/3" },
        ],
      },
    },
  ]);
  const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch });
  const provider = new PiloterrSearchProvider({ engine: "alibaba", client });

  const result = await provider.search({
    query: "x",
    framePosition: 0,
    frameSize: 10,
    sort: "default",
  });
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["3"]
  );
});

test("uno schema di risposta cambiato è un errore esplicito, non zero risultati", async () => {
  const { fetch } = stubFetch([{ body: { data: { items: [] } } }]);
  const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch });
  const provider = new PiloterrSearchProvider({ engine: "alibaba", client });

  await assert.rejects(
    () =>
      provider.search({
        query: "x",
        framePosition: 0,
        frameSize: 10,
        sort: "default",
      }),
    /schema dell'API è cambiato/
  );
});

test("la ricerca AliExpress usa la valuta dichiarata dalla fonte", async () => {
  const { fetch } = stubFetch([
    {
      body: {
        results: [
          {
            product_id: "100500",
            title: "Power bank 10000mAh",
            listing_url: "https://it.aliexpress.com/item/100500.html",
            price: "12.99",
            currency: "EUR",
            sold_count: 3000,
            rating: 4.7,
          },
        ],
      },
    },
  ]);
  const client = new PiloterrClient({ apiKey: "k", fetchImpl: fetch });
  const provider = new PiloterrSearchProvider({ engine: "aliexpress", client });

  const result = await provider.search({
    query: "power bank",
    framePosition: 0,
    frameSize: 5,
    sort: "default",
  });
  const [item] = result.items;
  assert.equal(item?.originalPrice, 12.99, "i numeri in stringa vanno convertiti");
  assert.equal(item?.currency, "EUR");
  assert.equal(item?.rating, 4.7);
  assert.equal(item?.moq, null, "AliExpress è al dettaglio: nessun minimo d'ordine");
});

test("il motore usa Piloterr solo quando la chiave è configurata", async () => {
  const browserCalls: string[] = [];
  const browserProvider = {
    name: "alibaba",
    search: async () => {
      browserCalls.push("browser");
      return {
        provider: "alibaba",
        query: "x",
        framePosition: 0,
        frameSize: 1,
        sort: "default" as const,
        totalCount: null,
        items: [],
      };
    },
  };

  const { fetch } = stubFetch([{ body: ALIBABA_PAGE }]);
  const withoutKey = new RoutedSearchProvider(
    "alibaba",
    new PiloterrSearchProvider({
      engine: "alibaba",
      client: new PiloterrClient({ apiKey: "", fetchImpl: fetch }),
    }),
    browserProvider
  );
  await withoutKey.search({ query: "x", framePosition: 0, frameSize: 1, sort: "default" });
  assert.deepEqual(browserCalls, ["browser"], "senza chiave si usa il browser");
  assert.equal(withoutKey.getHealth().route, "browser");

  const withKey = new RoutedSearchProvider(
    "alibaba",
    new PiloterrSearchProvider({
      engine: "alibaba",
      client: new PiloterrClient({ apiKey: "k", fetchImpl: fetch }),
    }),
    browserProvider
  );
  const result = await withKey.search({
    query: "x",
    framePosition: 0,
    frameSize: 1,
    sort: "default",
  });
  assert.deepEqual(browserCalls, ["browser"], "con la chiave il browser non va toccato");
  assert.equal(result.items.length, 1);
  assert.equal(withKey.getHealth().route, "piloterr");
});

test("lettura del minimo d'ordine e della valuta dal testo", () => {
  assert.equal(parseMinOrder("1 piece"), 1);
  assert.equal(parseMinOrder("1,000 pieces"), 1000);
  assert.equal(parseMinOrder("2 sets"), 2);
  assert.equal(parseMinOrder(null), null);
  assert.equal(parseMinOrder("negoziabile"), null);

  assert.equal(parseCurrency("US $14.90-$19.90", "CNY"), "USD");
  assert.equal(parseCurrency("€12,00", "USD"), "EUR");
  assert.equal(parseCurrency("¥88", "USD"), "CNY");
  // Testo non riconoscibile: si tiene il valore della fonte, non si indovina.
  assert.equal(parseCurrency("prezzo su richiesta", "USD"), "USD");
});
