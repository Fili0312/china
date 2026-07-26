import assert from "node:assert/strict";
import { test } from "node:test";
import { findShareInRow, parseTaobaoShareText } from "./share-text";

/**
 * Il blocco di condivisione di Taobao incollato nel foglio.
 *
 * Le due righe che questi test recuperano vengono dal file reale del cliente:
 * risultavano «senza nome prodotto» e venivano saltate, mentre contenevano il
 * nome esatto del prodotto e il link a quello che il cliente aveva già visto.
 */

const SHARE =
  "淘宝】https://e.tb.cn/h.RJsvIUi3MQX6pAM?tk=RYKTg7tY5yz CZ009 " +
  "「欧普AAAAA护眼灯LED专业学习灯书桌学生宿舍充电便携台灯官方正品」 " +
  "点击链接直接打开 或者 淘宝搜索直接打开";

test("dal blocco di condivisione si ricavano titolo e link", () => {
  const parsed = parseTaobaoShareText(SHARE);
  assert.ok(parsed);
  assert.equal(
    parsed.title,
    "欧普AAAAA护眼灯LED专业学习灯书桌学生宿舍充电便携台灯官方正品"
  );
  assert.equal(parsed.url, "https://e.tb.cn/h.RJsvIUi3MQX6pAM?tk=RYKTg7tY5yz");
});

test("il contorno non entra nel titolo", () => {
  const parsed = parseTaobaoShareText(SHARE);
  // «点击链接直接打开» è un invito ad aprire il link, non una caratteristica
  // del prodotto: nella query cinese sarebbe rumore puro.
  assert.ok(!parsed!.title!.includes("点击链接"));
  assert.ok(!parsed!.title!.includes("淘宝搜索"));
  assert.ok(!parsed!.title!.includes("tk="));
});

test("la riga viene recuperata da qualunque colonna", () => {
  // Nel foglio reale il blocco sta in una colonna senza intestazione, dopo
  // data, richiedente e reparto.
  const cells = ["6/24/26", "蒋俊理", "生产部", SHARE];
  const found = findShareInRow(cells);
  assert.ok(found?.title);
  assert.match(found.title, /护眼灯/);
});

test("un testo che non è una condivisione Taobao non produce nulla", () => {
  assert.equal(parseTaobaoShareText("平板灯 60*60"), null);
  assert.equal(parseTaobaoShareText("nota interna del reparto"), null);
  assert.equal(parseTaobaoShareText(""), null);
  assert.equal(parseTaobaoShareText(null), null);
  assert.equal(findShareInRow(["1", "2026-06-24", "生产部"]), null);
});

test("un link di un altro marketplace non viene scambiato per Taobao", () => {
  // Prudenza deliberata: meglio segnalare la riga che inventarle un prodotto.
  assert.equal(
    parseTaobaoShareText("淘宝 https://www.alibaba.com/product-detail/123.html 「qualcosa」"),
    null
  );
});

test("una condivisione con link diretto al prodotto funziona lo stesso", () => {
  const parsed = parseTaobaoShareText(
    "【淘宝】https://item.taobao.com/item.htm?id=783228964314 「陶瓷针规 5mm 塞规量棒」"
  );
  assert.equal(parsed?.title, "陶瓷针规 5mm 塞规量棒");
  assert.equal(parsed?.url, "https://item.taobao.com/item.htm?id=783228964314");
});

test("un titolo troppo corto non viene accettato", () => {
  // Quattro caratteri sono il minimo per non scambiare una sigla per un nome.
  assert.equal(parseTaobaoShareText("淘宝】https://e.tb.cn/h.X 「ab」")?.title, null);
});
