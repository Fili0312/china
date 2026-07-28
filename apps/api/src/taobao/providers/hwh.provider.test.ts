import assert from "node:assert/strict";
import test from "node:test";
import { readHwhUpstreamError } from "./hwh.provider";
import { mapSearchPayload } from "./taobao-item";

/**
 * «Taobao API by H-W-H» risponde HTTP 200 anche quando fallisce: l'esito vero
 * sta nel corpo. Le fixture di errore qui sotto sono risposte REALI osservate
 * il 2026-07-24 — non ipotesi di come il fornitore potrebbe sbagliare.
 */

test("l'errore «temporarily unavailable» dentro un 200 è un errore, e si ritenta", () => {
  // Risposta vera del 2026-07-24, con l'upstream del fornitore giù.
  const real = {
    result: { status: { msg: "error", code: 500, sub_code: "api.temporarily.unavailable" } },
  };
  const error = readHwhUpstreamError(real);
  assert.ok(error, "un errore nel corpo non può passare per «nessun risultato»");
  assert.equal(error.retryable, true);
  assert.match(error.message, /H-W-H/);
});

test("un api= sconosciuto è un errore di configurazione: non si ritenta", () => {
  // Risposta vera alla prova con api=item_search_2.
  const real = {
    result: {
      status: {
        msg: "error",
        code: 465,
        sub_code: "invalid-parameter:api.item_search_2.does.not.exist",
      },
    },
  };
  const error = readHwhUpstreamError(real);
  assert.ok(error);
  assert.equal(error.retryable, false);
  assert.match(error.message, /HWH_API_NAME/);
});

test("una risposta senza errore non solleva niente", () => {
  assert.equal(readHwhUpstreamError({ result: { status: { msg: "success" } } }), null);
  assert.equal(readHwhUpstreamError({ result: { item: [] } }), null);
  assert.equal(readHwhUpstreamError({}), null);
});

test("i prodotti H-W-H arrivano normalizzati con la provenienza giusta", () => {
  // Forma tipica delle risposte item_search dei proxy Taobao: il mapper
  // condiviso deve trovarla e normalizzarla senza codice dedicato.
  const payload = {
    result: {
      status: { msg: "success", code: 200 },
      item: [
        {
          num_iid: "672412580162",
          title: "高温纸胶带 50MM宽",
          pic: "//img.alicdn.com/foo.jpg",
          price: "12.80",
          promotion_price: "9.90",
          sales: "356",
          detail_url: "https://item.taobao.com/item.htm?id=672412580162",
          seller_id: "12345",
          shop_title: "胶带旗舰店",
        },
        // Un elemento senza id né titolo non deve diventare un prodotto.
        { foo: "bar" },
      ],
    },
  };

  const products = mapSearchPayload(payload, "hwh");
  assert.equal(products.length, 1);
  const product = products[0]!;
  assert.equal(product.source, "hwh");
  assert.equal(product.platform, "taobao");
  assert.equal(product.itemId, "672412580162");
  // Semantica del mapper condiviso: `price` è il **listino**, `promotionPrice`
  // lo scontato. Il prezzo che si paga oggi lo compone chi mostra il dato,
  // così il listino resta disponibile per riconciliare la cifra con la pagina.
  assert.equal(product.price, 12.8);
  assert.equal(product.promotionPrice, 9.9);
  assert.equal(product.totalSales, 356);
  assert.match(product.url ?? "", /672412580162/);
  assert.match(product.imageUrl ?? "", /^https:/);
});

test("stesso item id due volte nel payload: un prodotto solo (dedup)", () => {
  const entry = {
    num_iid: "111111111",
    title: "prodotto",
    price: "5",
  };
  const products = mapSearchPayload({ result: { item: [entry, { ...entry }] } }, "hwh");
  assert.equal(products.length, 1);
});
