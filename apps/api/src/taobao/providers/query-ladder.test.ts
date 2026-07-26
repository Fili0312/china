import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQueryLadder } from "./query-ladder";

/**
 * I marketplace cinesi combinano i termini in AND: una query che descrive bene
 * il prodotto può non trovare niente. Il caso che ha motivato questa scala
 * viene dal file reale — `珍珠白4层货架 加厚中型 200*40*140 300KG/层` tornava
 * con zero candidati mentre lo scaffale su Taobao esiste.
 */

test("una query lunga produce tentativi via via più larghi", () => {
  const ladder = buildQueryLadder("珍珠白4层货架 加厚中型 200*40*140 300KG/层");
  assert.deepEqual(ladder, [
    "珍珠白4层货架 加厚中型 200*40*140 300KG/层",
    "珍珠白4层货架 加厚中型",
    "珍珠白4层货架",
  ]);
});

test("l'accorciamento tiene il nome del prodotto e butta le specifiche", () => {
  // La query cinese si costruisce come 品名 + 规格型号: il nome viene prima, ed
  // è l'ultima cosa che deve sparire.
  const ladder = buildQueryLadder("平板灯 60*60 白色 嵌入式");
  assert.equal(ladder[ladder.length - 1], "平板灯");
  for (const attempt of ladder) assert.ok(attempt.startsWith("平板灯"));
});

test("una query corta non ha niente da accorciare", () => {
  assert.deepEqual(buildQueryLadder("电动车防盗锁"), ["电动车防盗锁"]);
  assert.deepEqual(buildQueryLadder("针规 2.48mm"), ["针规 2.48mm", "针规"]);
});

test("non si superano i tre tentativi", () => {
  const ladder = buildQueryLadder("a b c d e f g h i j k l");
  assert.ok(ladder.length <= 3, `tentativi: ${ladder.length}`);
});

test("i tentativi non si ripetono", () => {
  const ladder = buildQueryLadder("平板灯  60*60");
  assert.equal(new Set(ladder).size, ladder.length);
});

test("una query vuota non produce tentativi", () => {
  assert.deepEqual(buildQueryLadder(""), []);
  assert.deepEqual(buildQueryLadder("   "), []);
});

test("la scala è deterministica: la cache la riconosce", () => {
  const query = "陶瓷针规 5mm 高精度 通止规";
  assert.deepEqual(buildQueryLadder(query), buildQueryLadder(query));
});
