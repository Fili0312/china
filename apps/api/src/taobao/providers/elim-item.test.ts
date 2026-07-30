import assert from "node:assert/strict";
import { test } from "node:test";
import { elimPlatform } from "./elim.client";
import { elimItems, mapElimSearch, readPlanStatus } from "./elim-item";
import TAOBAO_FIXTURE from "./elim-taobao.fixture.json";
import ALIBABA_FIXTURE from "./elim-1688.fixture.json";
import {
  elimDetailToProduct,
  mapElimDetail,
  pickElimSku,
} from "./elim-detail";

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

/* -------------------------------------------------------------------------- */
/* Dettaglio e scelta della variante (v3)                                      */
/* -------------------------------------------------------------------------- */

const dettaglioStecchini = {
  success: true,
  id: "1055234541831",
  title: "牙签双尖竹制掏饭店餐双头尖吃水果袋装小包装竹牙签牙签棒酒店挑",
  price: 3,
  shop_name: "甜甜的杂货铺",
  quantity: 900,
  skus: [
    { id: "s1", price: 3, quantity: 100, options: [{ name: "颜色分类", value: "牙签1包(基础款)" }] },
    { id: "s2", price: 4, quantity: 100, options: [{ name: "颜色分类", value: "牙签1包(升级款)" }] },
    { id: "s3", price: 6, quantity: 100, options: [{ name: "颜色分类", value: "牙签3包(升级款)" }] },
  ],
};

test("il dettaglio ElimAPI diventa varianti con il loro prezzo", () => {
  const detail = mapElimDetail(dettaglioStecchini, "taobao");
  assert.equal(detail?.skus.length, 3);
  assert.equal(detail?.skus[2]?.label, "牙签3包(升级款)");
  assert.equal(detail?.skus[2]?.price, 6);
});

// Comanda il foglio, non il link. Sembra il contrario del buon senso — l'id è
// un dato esatto — ma è l'id a invecchiare: è quello che il cliente aveva
// davanti quando ha copiato l'indirizzo.
test("la colonna del foglio vince sullo skuId del link", () => {
  const detail = mapElimDetail(dettaglioStecchini, "taobao")!;
  const scelta = pickElimSku(detail, { skuId: "s3", spec: "牙签1包(基础款)" });
  assert.equal(scelta.match, "from_spec");
  assert.equal(scelta.sku?.price, 3);
});

test("lo skuId del link resta il ripiego quando il testo non decide", () => {
  const detail = mapElimDetail(dettaglioStecchini, "taobao")!;
  const scelta = pickElimSku(detail, { skuId: "s3", spec: "" });
  assert.equal(scelta.match, "from_link");
  assert.equal(scelta.sku?.price, 6);
});

// I calibri si vendono a fasce di diametro: senza questo, su una riga «2.48»
// nessuna etichetta combacia e la variante resterebbe da scegliere a mano.
// Le etichette qui sotto sono quelle vere dell'inserzione 18990351868.
test("una misura dentro una fascia sceglie la variante giusta", () => {
  const calibri = mapElimDetail(
    {
      success: true,
      id: "18990351868",
      title: "销式塞规精密针规正品针规0.1-100pin规针规高精量棒测量针规套装",
      price: 3.5,
      skus: [
        { id: "a", price: 15, options: [{ name: "规格", value: "0.10-0.20" }] },
        { id: "b", price: 6, options: [{ name: "规格", value: "0.21-0.50" }] },
        { id: "c", price: 3.5, options: [{ name: "规格", value: "0.51-1.99" }] },
        { id: "d", price: 4, options: [{ name: "规格", value: "2.00-5.99" }] },
        { id: "e", price: 8, options: [{ name: "规格", value: "10.00-12.00" }] },
      ],
    },
    "taobao"
  )!;
  // Il link puntava alla fascia sbagliata: il foglio ha ragione.
  const scelta = pickElimSku(calibri, { skuId: "c", spec: "2.48" });
  assert.equal(scelta.match, "from_spec");
  assert.equal(scelta.sku?.label, "2.00-5.99");
  assert.equal(scelta.sku?.price, 4);

  // Con l'unità attaccata funziona uguale.
  assert.equal(pickElimSku(calibri, { spec: "10.50mm" }).sku?.label, "10.00-12.00");

  // Due numeri non sono una misura: «60*60» non va cercato in una fascia.
  assert.equal(pickElimSku(calibri, { spec: "60*60" }).match, "ambiguous");
});

// Etichette vere dell'inserzione 783228964314: il diametro chiesto sta dentro
// il pezzo singolo **e** dentro quattro cofanetti che lo contengono per caso.
test("fra le fasce che contengono la misura vince la più stretta", () => {
  const chiodi = mapElimDetail(
    {
      success: true,
      id: "783228964314",
      title: "皖量高精度陶瓷针规塞规量棒",
      price: 5,
      skus: [
        { id: "a", price: 25, options: [{ name: "规格", value: "银色陶瓷10.0-10.99（范围内单价） 精度±0.001mm" }] },
        { id: "b", price: 1800, options: [{ name: "规格", value: "栗色高精度陶瓷套装Φ9-10 共101支" }] },
        { id: "c", price: 7999, options: [{ name: "规格", value: "高精度陶瓷套装Φ1-10 共901支" }] },
        { id: "d", price: 8880, options: [{ name: "规格", value: "深棕色高精度陶瓷套装Φ0.3-10 共971支" }] },
      ],
    },
    "taobao"
  )!;
  const scelta = pickElimSku(chiodi, { spec: "10.00mm" });
  assert.equal(scelta.match, "from_spec");
  assert.equal(scelta.sku?.price, 25);
});

test("la colonna specifiche sceglie la variante, anche scritta diversamente", () => {
  const detail = mapElimDetail(dettaglioStecchini, "taobao")!;
  // Parentesi tonde diverse e spazi in mezzo: per una persona è la stessa cosa.
  const scelta = pickElimSku(detail, { spec: "牙签 3 包（升级款）" });
  assert.equal(scelta.match, "from_spec");
  assert.equal(scelta.sku?.price, 6);
});

test("quando il testo combacia con più varianti non si tira a indovinare", () => {
  const detail = mapElimDetail(dettaglioStecchini, "taobao")!;
  // «牙签» sta dentro tutte e tre: sceglierne una sarebbe inventare.
  const scelta = pickElimSku(detail, { spec: "牙签" });
  assert.equal(scelta.match, "ambiguous");
  assert.equal(scelta.sku, null);
  assert.equal(scelta.candidates.length, 3);
});

test("il prodotto porta il prezzo della variante, non quello di testa", () => {
  const detail = mapElimDetail(dettaglioStecchini, "taobao")!;
  const scelta = pickElimSku(detail, { skuId: "s3" });
  const prodotto = elimDetailToProduct(detail, scelta, "https://item.taobao.com/x");
  assert.equal(prodotto.price, 6);
  assert.equal(prodotto.variantPrice, 6);
  assert.equal(prodotto.sku, "牙签3包(升级款)");
  // Senza variante scelta resta il prezzo di testa, che con `by_sku` è il
  // minimo: la riga dovrà dire che la variante manca.
  const senza = elimDetailToProduct(detail, { sku: null, match: "ambiguous", candidates: [] }, null);
  assert.equal(senza.price, 3);
  assert.equal(senza.variantPrice, null);
});
