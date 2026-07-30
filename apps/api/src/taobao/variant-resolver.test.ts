import assert from "node:assert/strict";
import test from "node:test";
import { mapElimDetail } from "./providers/elim-detail";
import { VariantResolverService } from "./variant-resolver.service";
import type { ScoredProduct } from "./scoring";

/**
 * Chi vince fra i candidati, quando i prezzi diventano quelli veri.
 *
 * Il caso è quello della riga 19 del foglio reale, dove il difetto si vedeva:
 * il foglio chiede un calibro da 1,999 mm, la ricerca mette primo un cofanetto
 * FENGJIE a 14 e secondo un ARODEK a 10. Ma quel 10 è il prezzo **di testa**,
 * il minimo fra le quarantanove fasce dell'inserzione: la fascia che contiene
 * 1,999 costa 15. Ordinare sui prezzi di testa premiava il cofanetto.
 */

function prodotto(itemId: string, price: number): ScoredProduct {
  return {
    product: {
      platform: "taobao",
      itemId,
      title: "",
      price,
      url: `https://item.taobao.com/item.htm?id=${itemId}`,
    },
    score: 0,
    breakdown: {},
    matchedRequirements: [],
    missingRequirements: [],
    warnings: [],
  } as unknown as ScoredProduct;
}

const FENGJIE = mapElimDetail(
  {
    success: true,
    id: "656612587729",
    title: "FENGJIE钨钢针规 硬质合金针规 量规高精度塞规 钨钢针止通规套装",
    price: 14,
    skus: [
      { id: "a", price: 14, options: [{ name: "规格", value: "0.1-1.0共91支套装" }] },
      { id: "b", price: 260, options: [{ name: "规格", value: "1.0-2.0共101支套装" }] },
    ],
  },
  "taobao"
)!;

const ARODEK = mapElimDetail(
  {
    success: true,
    id: "522545659451",
    title: "ARODEK钨钢针规高精度镜面高光超硬耐磨合金塞规针规加长非标定制",
    price: 10,
    skus: [
      { id: "x", price: 10, options: [{ name: "规格", value: "高精度钨钢0.200-1.000范围 单支价" }] },
      { id: "y", price: 15, options: [{ name: "规格", value: "高精度钨钢1.001-4.000范围 单支价" }] },
      { id: "z", price: 25, options: [{ name: "规格", value: "高精度钨钢4.001-5.000范围 单支价" }] },
    ],
  },
  "taobao"
)!;

function servizio(dettagli: Record<string, unknown>): VariantResolverService {
  const elim = {
    isConfigured: true,
    detail: async (itemId: string) => ({ detail: dettagli[itemId] ?? null, calls: 1 }),
  };
  return new VariantResolverService(elim as never);
}

test("vince il pezzo giusto, non il cofanetto col prezzo di testa più basso", async () => {
  const ranked = [prodotto("656612587729", 14), prodotto("522545659451", 10)];
  const esito = await servizio({
    "656612587729": FENGJIE,
    "522545659451": ARODEK,
  }).resolveAndPick({
    ranked,
    spec: "高精度钨钢1.999",
    displayName: "针规",
  });

  assert.equal(esito.elimCalls, 2);
  assert.equal(esito.resolved, true);
  // ARODEK passa in testa, con la fascia che contiene 1,999 e il suo prezzo.
  assert.equal(esito.ranked[0]!.product.itemId, "522545659451");
  assert.equal(esito.ranked[0]!.product.price, 15);
  assert.equal(esito.ranked[0]!.product.sku, "高精度钨钢1.001-4.000范围 单支价");
  // Il link porta alla variante, non all'inserzione.
  assert.match(esito.ranked[0]!.product.url!, /skuId=y/);
  // E nessuno perde il posto: cambia l'ordine, non l'elenco.
  assert.equal(esito.ranked.length, 2);
});

test("il cofanetto vince se è il foglio a chiederlo", async () => {
  const ranked = [prodotto("522545659451", 10), prodotto("656612587729", 14)];
  const esito = await servizio({
    "656612587729": FENGJIE,
    "522545659451": ARODEK,
  }).resolveAndPick({
    ranked,
    spec: "1.0-2.0共101支套装",
    displayName: "针规",
  });

  assert.equal(esito.ranked[0]!.product.itemId, "656612587729");
  assert.equal(esito.ranked[0]!.product.price, 260);
});

test("senza nessun candidato risolto la classifica resta quella della ricerca", async () => {
  const ranked = [prodotto("111", 3), prodotto("222", 4)];
  const esito = await servizio({}).resolveAndPick({
    ranked,
    spec: "una specifica qualsiasi",
    displayName: "riga",
  });

  assert.equal(esito.resolved, false);
  assert.equal(esito.ranked[0]!.product.itemId, "111");
  assert.equal(esito.ranked[0]!.product.price, 3);
});

test("senza Elim configurata non si spende e non si tocca niente", async () => {
  const elim = {
    isConfigured: false,
    detail: async () => {
      throw new Error("non deve essere chiamata");
    },
  };
  const ranked = [prodotto("111", 3)];
  const esito = await new VariantResolverService(elim as never).resolveAndPick({
    ranked,
    spec: "qualcosa",
    displayName: "riga",
  });

  assert.equal(esito.elimCalls, 0);
  assert.equal(esito.ranked[0]!.product.price, 3);
});
