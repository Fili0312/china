import assert from "node:assert/strict";
import { test } from "node:test";
import { TAOBAO_SOURCES } from "@china/shared";
import { mergeProducts } from "./merge";
import type { RawTaobaoProduct } from "./providers/taobao-item";

/**
 * L'unione delle fonti.
 *
 * Due errori opposti da evitare, entrambi visti nei dati reali di altri
 * marketplace: fondere prodotti diversi perché hanno lo stesso titolo — su
 * Taobao decine di venditori copiano la stessa riga — e mostrare quattro volte
 * lo stesso prodotto perché è arrivato da quattro fonti.
 */

function product(overrides: Partial<RawTaobaoProduct> = {}): RawTaobaoProduct {
  return {
    platform: "taobao",
    itemId: "123456789",
    title: "陶瓷针规 5mm",
    titleEn: null,
    url: "https://item.taobao.com/item.htm?id=123456789",
    imageUrl: null,
    price: 100,
    currency: "CNY",
    variantPrice: null,
    promotionPrice: null,
    moq: null,
    sku: null,
    shopName: null,
    shopUrl: null,
    sellerId: null,
    totalSales: null,
    reviewCount: null,
    rating: null,
    specs: null,
    variants: null,
    availability: null,
    shipping: null,
    source: "api",
    ...overrides,
  };
}

test("lo stesso item id da fonti diverse diventa un solo candidato", () => {
  const merged = mergeProducts([
    product({ source: "api", price: 100 }),
    product({ source: "playwright", price: 100 }),
    product({ source: "memory", price: 100 }),
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.sources.sort(), ["api", "memory", "playwright"]);
});

test("due prodotti con lo stesso titolo ma id diversi restano due", () => {
  // È il caso più frequente su Taobao: stesso testo, venditori diversi,
  // prezzi diversi. Fonderli cancellerebbe l'alternativa più economica.
  const merged = mergeProducts([
    product({ itemId: "111111111", price: 100 }),
    product({ itemId: "222222222", price: 78 }),
  ]);

  assert.equal(merged.length, 2);
});

test("il prezzo di Playwright batte quello dell'API", () => {
  // Playwright vede il prezzo con la sessione aperta: è quello che pagherà
  // davvero chi compra.
  const merged = mergeProducts([
    product({ source: "api", price: 120 }),
    product({ source: "playwright", price: 98 }),
  ]);

  assert.equal(merged[0]!.price, 98);
});

test("le specifiche strutturate dell'API battono quelle del browser", () => {
  const merged = mergeProducts([
    product({ source: "playwright", specs: { 发货地: "浙江" } }),
    product({ source: "api", specs: { 材质: "陶瓷", 精度: "0.001mm" } }),
  ]);

  assert.deepEqual(merged[0]!.specs, { 材质: "陶瓷", 精度: "0.001mm" });
});

test("un campo mancante nella fonte preferita si prende dall'altra", () => {
  const merged = mergeProducts([
    product({ source: "playwright", price: 98, shopName: null }),
    product({ source: "api", price: null, shopName: "旗舰店" }),
  ]);

  assert.equal(merged[0]!.price, 98);
  assert.equal(merged[0]!.shopName, "旗舰店");
});

test("prezzi molto diversi fra fonti diventano un avviso, non una scelta muta", () => {
  const merged = mergeProducts([
    product({ source: "api", price: 100 }),
    product({ source: "playwright", price: 60 }),
  ]);

  assert.equal(merged[0]!.conflicts.length, 1);
  assert.match(merged[0]!.conflicts[0]!, /Prezzo diverso/);
});

test("una differenza di prezzo minima non genera avvisi", () => {
  const merged = mergeProducts([
    product({ source: "api", price: 100 }),
    product({ source: "playwright", price: 102 }),
  ]);

  assert.deepEqual(merged[0]!.conflicts, []);
});

test("disponibilità discordanti vengono segnalate", () => {
  const merged = mergeProducts([
    product({ source: "api", availability: "in stock" }),
    product({ source: "memory", availability: "sold out" }),
  ]);

  assert.equal(merged[0]!.conflicts.length, 1);
  assert.match(merged[0]!.conflicts[0]!, /Disponibilità discordante/);
});

test("una lettura fresca smentisce il «non disponibile» salvato", () => {
  const merged = mergeProducts([
    product({ source: "memory", unavailable: true }),
    product({ source: "api", unavailable: false }),
  ]);

  assert.equal(merged[0]!.unavailable, false);
});

test("il link Excel senza dati si fonde con il prodotto trovato", () => {
  // La riga dell'Excel porta solo l'id: tutto il resto arriva dalla ricerca,
  // ma la provenienza «excel» resta, perché è il prodotto che il cliente
  // aveva già indicato.
  const merged = mergeProducts([
    product({ source: "excel", price: null, title: "riga 12" }),
    product({ source: "api", price: 100, title: "陶瓷针规 5mm 高精度" }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.title, "陶瓷针规 5mm 高精度");
  assert.equal(merged[0]!.price, 100);
  assert.ok(merged[0]!.sources.includes("excel"));
});

test("l'ordine delle fonti in ingresso non cambia il risultato", () => {
  const entries = [
    product({ source: "api", price: 120, shopName: "A" }),
    product({ source: "playwright", price: 98 }),
    product({ source: "memory", price: 130, totalSales: 42 }),
  ];
  const forward = mergeProducts(entries);
  const backward = mergeProducts([...entries].reverse());

  assert.deepEqual(forward[0]!.price, backward[0]!.price);
  assert.deepEqual(forward[0]!.shopName, backward[0]!.shopName);
  assert.deepEqual(forward[0]!.totalSales, backward[0]!.totalSales);
});

/* -------------------------------------------------------------------------- */
/* Due piattaforme, una classifica                                             */
/* -------------------------------------------------------------------------- */

test("Taobao e 1688 con lo stesso id restano due prodotti", () => {
  // Gli identificativi sono numerici su entrambi i marketplace e niente
  // garantisce che non collidano: fonderli mostrerebbe un'offerta all'ingrosso
  // sotto il link del prodotto al dettaglio.
  const merged = mergeProducts([
    product({ platform: "taobao", itemId: "998180612776", price: 21 }),
    product({ platform: "1688", itemId: "998180612776", price: 12 }),
  ]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((entry) => entry.platform).sort(), ["1688", "taobao"]);
});

test("lo stesso prodotto Taobao da DataHub ed ElimAPI diventa uno solo", () => {
  const merged = mergeProducts([
    product({ source: "api", price: 13.8, shopName: null }),
    product({ source: "elim", price: 13.8, shopName: "祥奈尔工厂直销", titleEn: "Led Panel" }),
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.sources.sort(), ["api", "elim"]);
  // Ogni fonte porta ciò che l'altra non ha.
  assert.equal(merged[0]!.shopName, "祥奈尔工厂直销");
  assert.equal(merged[0]!.titleEn, "Led Panel");
});

test("il prezzo di DataHub batte quello di ElimAPI, ma non quello di Playwright", () => {
  const withElim = mergeProducts([
    product({ source: "elim", price: 20 }),
    product({ source: "api", price: 18 }),
  ]);
  assert.equal(withElim[0]!.price, 18);

  const withBrowser = mergeProducts([
    product({ source: "elim", price: 20 }),
    product({ source: "api", price: 18 }),
    product({ source: "playwright", price: 15 }),
  ]);
  assert.equal(withBrowser[0]!.price, 15);
});

test("MOQ e prezzo promozionale sopravvivono all'unione", () => {
  const merged = mergeProducts([
    product({ source: "api", moq: null, promotionPrice: null }),
    product({ source: "elim", moq: 50, promotionPrice: 13.8 }),
  ]);
  assert.equal(merged[0]!.moq, 50);
  assert.equal(merged[0]!.promotionPrice, 13.8);
});

test("ogni provenienza dell'elenco condiviso è riconosciuta", () => {
  // Difetto vero: `elim` era stato aggiunto all'elenco ma non al filtro che
  // valida le provenienze lette da database, e i prodotti di ElimAPI
  // arrivavano in interfaccia senza indicazione di origine.
  for (const source of TAOBAO_SOURCES) {
    const merged = mergeProducts([product({ source })]);
    assert.deepEqual(merged[0]!.sources, [source], `provenienza persa: ${source}`);
  }
});
