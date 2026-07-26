import assert from "node:assert/strict";
import { test } from "node:test";
import { elimPlatform } from "./elim.client";
import { elimItems, mapElimSearch, readPlanStatus } from "./elim-item";
import TAOBAO_FIXTURE from "./elim-taobao.fixture.json";
import ALIBABA_FIXTURE from "./elim-1688.fixture.json";

/**
 * La lettura delle risposte ElimAPI.
 *
 * Le fixture sono risposte **vere**, salvate il 2026-07-22 — una per
 * piattaforma. Servono perché le due non restituiscono gli stessi campi e
 * perché lo Swagger e la realtà divergono in punti che contano: lo schema
 * dichiara `whosesale_price`, la risposta manda `wholesale_price`, e
 * `seller_name` non è documentato affatto.
 */

test("il nome della piattaforma viene tradotto per l'API", () => {
  // Dentro il progetto il marketplace si chiama 1688; `alibaba` è come lo
  // chiama questo fornitore, e la traduzione vive in un punto solo.
  assert.equal(elimPlatform("taobao"), "taobao");
  assert.equal(elimPlatform("1688"), "alibaba");
});

test("una risposta Taobao reale diventa prodotti completi", () => {
  const products = mapElimSearch(TAOBAO_FIXTURE, "taobao");
  assert.ok(products.length >= 1);

  const first = products[0]!;
  assert.equal(first.platform, "taobao");
  assert.match(first.itemId, /^\d{9,}$/);
  assert.ok(first.title.includes("平板灯"), "titolo cinese conservato");
  assert.ok(first.titleEn && first.titleEn.length > 5, "titolo inglese presente");
  assert.ok(first.url?.includes("item.taobao.com"));
  assert.equal(first.currency, "CNY");
  assert.equal(first.source, "elim");
  assert.ok(first.raw, "dati grezzi conservati");
});

test("una risposta 1688 reale porta i link di 1688", () => {
  const products = mapElimSearch(ALIBABA_FIXTURE, "1688");
  assert.ok(products.length >= 1);
  for (const product of products) {
    assert.equal(product.platform, "1688");
    assert.ok(product.url?.includes("1688.com"), `link inatteso: ${product.url}`);
  }
});

test("il prezzo mostrato è quello che si paga oggi", () => {
  // Nella fixture Taobao: price 21.8, promotion_price 13.8.
  const [first] = mapElimSearch(TAOBAO_FIXTURE, "taobao");
  assert.equal(first!.price, 13.8);
  assert.equal(first!.promotionPrice, 13.8, "la promozione resta visibile come tale");
});

test("senza promozione il prezzo promozionale resta nullo", () => {
  const products = mapElimSearch(ALIBABA_FIXTURE, "1688");
  const noPromo = products.find((product) => product.promotionPrice == null);
  assert.ok(noPromo, "almeno un prodotto senza promozione");
  assert.ok(noPromo.price != null && noPromo.price > 0);
});

test("vendite e voto arrivano da 1688, il venditore da Taobao", () => {
  const [wholesale] = mapElimSearch(ALIBABA_FIXTURE, "1688");
  assert.ok(wholesale!.totalSales != null && wholesale!.totalSales > 0);
  assert.ok(wholesale!.rating != null);

  const [retail] = mapElimSearch(TAOBAO_FIXTURE, "taobao");
  assert.ok(retail!.shopName, "seller_name di Taobao");
});

test("MOQ e SKU restano nulli invece di essere dedotti", () => {
  // La ricerca non li espone: stanno solo in `POST /v1/products/detail`.
  // Dedurre il MOQ da `quantity` — che è la disponibilità — farebbe comprare
  // sulla base di un numero inventato.
  for (const product of mapElimSearch(ALIBABA_FIXTURE, "1688")) {
    assert.equal(product.moq, null);
    assert.equal(product.sku, null);
  }
});

test("un prodotto senza id o senza titolo viene scartato", () => {
  const products = mapElimSearch(
    { success: true, items: [{ price: 10 }, { id: "1", title: "" }, { id: "2", title: "buono" }] },
    "taobao"
  );
  assert.equal(products.length, 1);
  assert.equal(products[0]!.itemId, "2");
});

test("`success: false` non viene scambiato per «nessun risultato»", () => {
  const { ok, items } = elimItems({ success: false, message: "quota exceeded", items: [] });
  assert.equal(ok, false);
  assert.equal(items.length, 0);
});

test("lo stato del piano dice quante richieste restano", () => {
  const plan = readPlanStatus({
    subscription: { plan: { name: "Free" } },
    usage: { included_limit: 200, total_requests: 12 },
  });
  assert.equal(plan.planName, "Free");
  assert.equal(plan.includedLimit, 200);
  assert.equal(plan.totalRequests, 12);
  assert.equal(plan.remaining, 188);
});
