import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCookies } from "@china/adapters";
import { runWithLocale } from "../i18n/request-locale";
import {
  canonicalItemUrl,
  decodeLinkEntities,
  extractItemId,
  findProductArray,
  mapDetailPayload,
  mapReviewPayload,
  mapSearchPayload,
  parseLooseNumber,
} from "./providers/taobao-item";

/**
 * La lettura delle risposte Taobao.
 *
 * È il punto più fragile del modulo, perché l'unica cosa che non controlliamo
 * è la forma dei dati altrui: un aggregatore rinomina `num_iid` in `item_id`
 * fra due revisioni e, senza tolleranza, la ricerca smette di trovare
 * qualunque cosa senza un errore visibile.
 */

test("l'id si estrae da un link Taobao con parametri di tracciamento", () => {
  assert.equal(
    extractItemId("https://item.taobao.com/item.htm?spm=a1z10.3&id=654321987&ns=1"),
    "654321987"
  );
});

test("l'id si estrae anche da Tmall e dagli identificativi nudi", () => {
  assert.equal(extractItemId("https://detail.tmall.com/item.htm?id=112233445"), "112233445");
  assert.equal(extractItemId("112233445"), "112233445");
});

test("un link di un altro sito non produce un id", () => {
  assert.equal(extractItemId("https://www.alibaba.com/product-detail/123456789.html"), null);
  assert.equal(extractItemId(""), null);
  assert.equal(extractItemId(null), null);
});

test("due link diversi dello stesso prodotto danno lo stesso id", () => {
  const a = extractItemId("https://item.taobao.com/item.htm?id=999888777&spm=abc");
  const b = extractItemId("//item.taobao.com/item.htm?id=999888777");
  assert.equal(a, b);
  assert.equal(canonicalItemUrl(a!), "https://item.taobao.com/item.htm?id=999888777");
});

test("i numeri arrivano in tutte le forme che usano le fonti", () => {
  assert.equal(parseLooseNumber(12.5), 12.5);
  assert.equal(parseLooseNumber("¥12.50"), 12.5);
  assert.equal(parseLooseNumber("12,50"), 1250);
  assert.equal(parseLooseNumber("1.2万"), 12000);
  assert.equal(parseLooseNumber("3000+人付款"), 3000);
  assert.equal(parseLooseNumber(null), null);
  assert.equal(parseLooseNumber("nessun numero"), null);
});

test("i prodotti si trovano comunque siano annidati", () => {
  const shapes: unknown[] = [
    { result: { item: [{ num_iid: "1", title: "A" }] } },
    { data: { items: [{ item_id: "1", name: "A" }] } },
    { items: [{ itemId: "1", raw_title: "A" }] },
    [{ id: "1", title: "A" }],
  ];

  for (const payload of shapes) {
    assert.equal(findProductArray(payload).length, 1, JSON.stringify(payload));
  }
});

test("una risposta di ricerca diventa una lista di prodotti", () => {
  const products = mapSearchPayload({
    result: {
      item: [
        {
          num_iid: "654321987",
          title: "陶瓷针规 5mm",
          promotion_price: "¥98.00",
          pic_url: "//img.alicdn.com/x.jpg",
          nick: "旗舰店",
          view_sales: "1.2万人付款",
          comment_count: "350",
        },
      ],
    },
  });

  assert.equal(products.length, 1);
  const product = products[0]!;
  assert.equal(product.itemId, "654321987");
  assert.equal(product.price, 98);
  assert.equal(product.currency, "CNY");
  assert.equal(product.imageUrl, "https://img.alicdn.com/x.jpg");
  assert.equal(product.shopName, "旗舰店");
  assert.equal(product.totalSales, 12000);
  assert.equal(product.reviewCount, 350);
  assert.equal(product.source, "api");
});

test("un elemento senza id o senza titolo viene scartato", () => {
  const products = mapSearchPayload({
    items: [
      { title: "senza id" },
      { num_iid: "123456789" },
      { num_iid: "987654321", title: "buono" },
    ],
  });

  assert.equal(products.length, 1);
  assert.equal(products[0]!.itemId, "987654321");
});

test("lo stesso prodotto ripetuto nella risposta compare una volta sola", () => {
  const products = mapSearchPayload({
    items: [
      { num_iid: "123456789", title: "A" },
      { num_iid: "123456789", title: "A (duplicato)" },
    ],
  });
  assert.equal(products.length, 1);
});

test("il dettaglio completa i campi invece di sostituirli", () => {
  // Un dettaglio senza vendite non deve azzerare le vendite lette in ricerca:
  // per questo torna un oggetto parziale e non un prodotto intero.
  const patch = mapDetailPayload({
    item: {
      num_iid: "1",
      title: "陶瓷针规",
      price: "120",
      props: [{ name: "材质", value: "陶瓷" }],
      skus: [{ name: "尺寸", values: ["5mm", "6mm"] }],
    },
  });

  assert.equal(patch.price, 120);
  assert.deepEqual(patch.specs, { 材质: "陶瓷" });
  assert.deepEqual(patch.variants, [{ name: "尺寸", options: ["5mm", "6mm"] }]);
  assert.equal(patch.totalSales, undefined);
});

test("le specifiche si leggono anche dalla forma `chiave:valore`", () => {
  const patch = mapDetailPayload({
    item: { num_iid: "1", title: "x", props: ["材质:不锈钢", "精度:0.01mm"] },
  });
  assert.deepEqual(patch.specs, { 材质: "不锈钢", 精度: "0.01mm" });
});

test("le recensioni tornano come numero e voto", () => {
  const reviews = mapReviewPayload({ data: { total: "128", rating: "4.8" } });
  assert.equal(reviews.reviewCount, 128);
  assert.equal(reviews.rating, 4.8);
});

/* -------------------------------------------------------------------------- */
/* Cookie della sessione                                                       */
/* -------------------------------------------------------------------------- */

test("i cookie esportati dalle estensioni diventano cookie Playwright", () => {
  // `expirationDate` e `no_restriction` sono la forma delle estensioni;
  // Playwright vuole `expires` e `None`, e un solo campo fuori posto fa
  // rifiutare l'intero elenco — cioè una sessione «collegata» che non
  // autentica nulla.
  const cookies = normalizeCookies([
    {
      name: "_tb_token_",
      value: "abc",
      domain: ".taobao.com",
      path: "/",
      expirationDate: 1893456000,
      sameSite: "no_restriction",
    },
    { name: "senza valore" },
    "non è un cookie",
  ]);

  assert.equal(cookies.length, 1);
  assert.equal(cookies[0]!.name, "_tb_token_");
  assert.equal(cookies[0]!.expires, 1893456000);
  assert.equal(cookies[0]!.sameSite, "None");
  // `sameSite: None` senza `secure` verrebbe rifiutato dal browser.
  assert.equal(cookies[0]!.secure, true);
});

test("un cookie senza dominio ricade su taobao.com", () => {
  const cookies = normalizeCookies([{ name: "cookie2", value: "x" }]);
  assert.equal(cookies[0]!.domain, ".taobao.com");
  assert.equal(cookies[0]!.path, "/");
});

/* -------------------------------------------------------------------------- */
/* La forma reale di Taobao DataHub                                            */
/* -------------------------------------------------------------------------- */

/**
 * Risposta vera dell'endpoint `/item_search`, salvata il 2026-07-22.
 *
 * È una fixture e non un mock inventato: la forma di questo payload è l'unica
 * cosa del progetto che non controlliamo, e i tre errori che ha già causato —
 * prodotti dentro una busta `{item, seller, delivery}`, prezzo due livelli
 * sotto in `sku.def`, identificativo cifrato in `itemIdStr` — non si sarebbero
 * visti su un payload scritto a mano.
 */
import REAL_SEARCH_FIXTURE from "./providers/datahub-search.fixture.json";

const REAL_SEARCH: unknown = REAL_SEARCH_FIXTURE;

test("la risposta reale di /item_search produce prodotti completi", () => {
  const products = mapSearchPayload(REAL_SEARCH);
  assert.ok(products.length >= 2, "almeno due prodotti dalla fixture");

  const first = products[0]!;
  assert.match(first.itemId, /^\d{9,}$/, "id numerico, non il token cifrato");
  assert.ok(first.title.length > 5);
  assert.equal(first.url, "https://item.taobao.com/item.htm?id=1002567275327");
  assert.ok(first.imageUrl?.startsWith("https://"), "immagine con schema");
  assert.equal(first.currency, "CNY");
  assert.ok(first.price != null && first.price > 0, "prezzo letto da sku.def");
  assert.ok(first.shopName, "negozio letto da seller.storeTitle");
  assert.ok(first.shipping?.includes("广东"), "spedizione da delivery.shippingFrom");
});

test("il prezzo promozionale batte quello pieno", () => {
  // `sku.def` espone `price` (35.00) e `promotionPrice` (13.80): quello che
  // pagherebbe chi compra oggi è il secondo.
  const products = mapSearchPayload(REAL_SEARCH);
  assert.equal(products[0]!.price, 13.8);
});

test("l'identità non è mai il token cifrato itemIdStr", () => {
  // `itemIdStr` cambia a ogni richiesta: se finisse nell'identità, ogni
  // ricerca creerebbe prodotti «nuovi» e la memoria non aggancerebbe mai.
  const products = mapSearchPayload(REAL_SEARCH);
  for (const product of products) {
    assert.ok(product.itemId.length <= 20, `id sospetto: ${product.itemId.slice(0, 30)}…`);
    assert.doesNotMatch(product.itemId, /[A-Za-z+/=]{20,}/);
  }
});

test("la spedizione gratuita viene detta a parole", () => {
  // Fuori da una richiesta HTTP vale la lingua predefinita: questi testi
  // finiscono nel database al momento della ricerca, quando la lingua di chi
  // guarderà il risultato non è ancora nota.
  const products = mapSearchPayload(REAL_SEARCH);
  assert.match(products[0]!.shipping!, /free shipping/);

  const inChinese = runWithLocale("zh", () => mapSearchPayload(REAL_SEARCH));
  assert.match(inChinese[0]!.shipping!, /包邮/);
});

test("senza campo immagine principale si ripiega sulla galleria", () => {
  // Forma reale della risposta DataHub: l'immagine di copertina manca ma la
  // galleria c'è. Prima la scheda restava senza foto pur avendole.
  const products = mapSearchPayload({
    result: {
      resultList: [
        {
          item: {
            itemId: "692155426067",
            title: "高精密陶瓷针规",
            itemUrl: "//item.taobao.com/item.htm?id=692155426067",
            images: {
              string: [
                "//img.alicdn.com/i3/3970730138/O1CN019mghgC1CtFg0k2zHl_!!3970730138.jpg",
                "//img.alicdn.com/i1/3970730138/O1CN01px4CZs1CtFg4szgoR_!!3970730138.jpg",
              ],
            },
          },
        },
      ],
    },
  });

  assert.equal(products.length, 1);
  assert.match(products[0]!.imageUrl ?? "", /^https:\/\/img\.alicdn\.com\/i3\//u);
});

test("la copertina esplicita continua a vincere sulla galleria", () => {
  const products = mapSearchPayload({
    result: {
      resultList: [
        {
          item: {
            itemId: "692155426068",
            title: "针规",
            itemUrl: "//item.taobao.com/item.htm?id=692155426068",
            image: "//img.alicdn.com/copertina.jpg",
            images: { string: ["//img.alicdn.com/galleria.jpg"] },
          },
        },
      ],
    },
  });

  assert.match(products[0]!.imageUrl ?? "", /copertina\.jpg$/u);
});

test("un link del foglio con entità HTML torna utilizzabile", () => {
  const raw =
    "https://item.taobao.com/item.htm?id=676382940055&amp;skuId=5928169846034&amp;scm=1007.13982";

  const decoded = decodeLinkEntities(raw);

  assert.equal(
    decoded,
    "https://item.taobao.com/item.htm?id=676382940055&skuId=5928169846034&scm=1007.13982"
  );
  // La variante scelta dal cliente sopravvive: era il parametro che si perdeva.
  assert.equal(new URL(decoded!).searchParams.get("skuId"), "5928169846034");
  assert.equal(extractItemId(decoded), "676382940055");
});

test("un link già pulito non viene toccato", () => {
  const clean = "https://item.taobao.com/item.htm?id=676382940055&skuId=59281";
  assert.equal(decodeLinkEntities(clean), clean);
  assert.equal(decodeLinkEntities(null), null);
  assert.equal(decodeLinkEntities("   "), null);
});
