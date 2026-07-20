import assert from "node:assert/strict";
import test from "node:test";
import { buildInquiryQuery, cleanReferenceTitle } from "./inquiry-query";

test("unisce nome e specifiche cinesi separando le virgole", () => {
  assert.equal(
    buildInquiryQuery("防静电椅", "黑色，升降，无靠背").query,
    "防静电椅 黑色 升降 无靠背"
  );
});

test("toglie le etichette di campo lasciando il contenuto", () => {
  assert.equal(
    buildInquiryQuery("品名: 防静电椅", "规格型号: 黑色，升降，无靠背").query,
    "防静电椅 黑色 升降 无靠背"
  );
});

test("conserva i codici modello con barre e trattini", () => {
  assert.equal(
    buildInquiryQuery("步进电机驱动器", "2HHS57-A-5/24").query,
    "步进电机驱动器 2HHS57-A-5/24"
  );
  assert.equal(
    buildInquiryQuery("激光测距传感器", "DJM-050-485").query,
    "激光测距传感器 DJM-050-485"
  );
  assert.equal(
    buildInquiryQuery("步进电机", "57J1880EC-1000-LS").query,
    "步进电机 57J1880EC-1000-LS"
  );
});

test("conserva misure e materiali", () => {
  assert.equal(
    buildInquiryQuery("货架", "珍珠白4层主架 加厚中型长200*宽40*高140 300KG/层")
      .query,
    "货架 珍珠白4层主架 加厚中型长200*宽40*高140 300KG/层"
  );
  assert.equal(
    buildInquiryQuery("气管", "8*5 100米德料透明").query,
    "气管 8*5 100米德料透明"
  );
  assert.equal(
    buildInquiryQuery("平板灯", "60*60").query,
    "平板灯 60*60"
  );
});

test("apre le parentesi senza perdere la specifica che contengono", () => {
  assert.equal(
    buildInquiryQuery("直线模组", "NN100-200（不带电机）").query,
    "直线模组 NN100-200 不带电机"
  );
  assert.equal(
    buildInquiryQuery("世达内六角扳手", "加长球头【12mm】81118").query,
    "世达内六角扳手 加长球头 12mm 81118"
  );
});

test("toglie le quantità di confezionamento ma non le misure", () => {
  const bolt = buildInquiryQuery("M8螺丝", "M8*35-20个");
  assert.equal(bolt.query, "M8螺丝 M8*35");
  assert.ok(bolt.dropped.includes("20个"));

  const wing = buildInquiryQuery("304不锈钢蝶形螺丝", "M5*35(10套)");
  assert.equal(wing.query, "304不锈钢蝶形螺丝 M5*35");

  const magnet = buildInquiryQuery("强力磁铁", "80x20x5mm-双沉孔M5（1个）");
  assert.equal(magnet.query, "强力磁铁 80x20x5mm-双沉孔M5");

  // 层 e KG sono misure: restano.
  assert.match(
    buildInquiryQuery("货架", "300KG/层").query,
    /300KG\/层/u
  );
});

test("toglie le quantità scritte in cinese attaccate al codice", () => {
  const label = buildInquiryQuery("OK标签", "1CM ok/一千个");
  assert.equal(label.query, "OK标签 1CM ok");
  assert.ok(label.dropped.includes("一千个"));
});

test("toglie reparto, richiedente e centro di costo", () => {
  const built = buildInquiryQuery(
    "防静电椅",
    "黑色 申请部门：物流部 申请人：蔡其梅 成本中心：质量"
  );
  assert.equal(built.query, "防静电椅 黑色");
  assert.equal(built.dropped.length, 3);
});

test("non ripete un termine presente sia nel nome sia nelle specifiche", () => {
  assert.equal(
    buildInquiryQuery("针规", "针规 2.48").query,
    "针规 2.48"
  );
});

test("normalizza gli a capo dentro il nome prodotto", () => {
  assert.equal(buildInquiryQuery("气管\n", "8*5").query, "气管 8*5");
});

test("resta entro il limite accettato dall'endpoint di ricerca", () => {
  const built = buildInquiryQuery("测试", "规格".repeat(200));
  assert.ok(built.query.length <= 200);
});

test("una riga senza specifiche produce comunque la query del nome", () => {
  assert.equal(buildInquiryQuery("电动车防盗锁", "").query, "电动车防盗锁");
});

test("ripulisce il suffisso marketplace dal titolo di riferimento", () => {
  assert.equal(
    cleanReferenceTitle(
      "万昌仓储货架多层置物架超强承重仓库货物架快递储物架家用铁架子-tmall.com天猫"
    ),
    "万昌仓储货架多层置物架超强承重仓库货物架快递储物架家用铁架子"
  );
  assert.equal(
    cleanReferenceTitle("皖量高精度陶瓷针规塞规量棒-淘宝网"),
    "皖量高精度陶瓷针规塞规量棒"
  );
});
