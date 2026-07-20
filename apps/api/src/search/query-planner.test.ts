import assert from "node:assert/strict";
import test from "node:test";
import { planSearchQuery } from "./query-planner";

test("normalizza powerbank e capacità", () => {
  assert.equal(
    planSearchQuery("powerbank 10.000 mah", "taobao").providerQuery,
    "powerbank 10000 mah"
  );
});

test("adatta la stessa intenzione all'indice del singolo motore", () => {
  assert.equal(
    planSearchQuery("powerbank 10000 mah", "taobao").providerQuery,
    "powerbank 10000 mah"
  );
  assert.equal(
    planSearchQuery("powerbank 10000 mah", "aliexpress").providerQuery,
    "power bank 10000mAh"
  );
});

test("traduce una richiesta italiana senza perdere gli attributi", () => {
  assert.equal(
    planSearchQuery("tazza ceramica bianca personalizzata", "chinagoods")
      .providerQuery,
    "mug ceramic white custom"
  );
});

test("normalizza capacità abbreviata", () => {
  assert.equal(
    planSearchQuery("caricatore portatile 10k mah nero", "yiwugo")
      .providerQuery,
    "power bank 10000mAh black"
  );
});

test("una query già in cinese arriva al marketplace così com'è", () => {
  for (const engine of ["yiwugo", "chinagoods", "alibaba", "taobao"] as const) {
    const plan = planSearchQuery("防静电椅 黑色 升降 无靠背", engine);
    assert.equal(plan.providerQuery, "防静电椅 黑色 升降 无靠背");
    assert.equal(plan.changed, false);
  }
});

test("conserva codici e misure delle richieste cinesi", () => {
  assert.equal(
    planSearchQuery("步进电机驱动器 2HHS57-A-5/24", "aliexpress").providerQuery,
    "步进电机驱动器 2HHS57-A-5/24"
  );
  assert.equal(
    planSearchQuery("货架 加厚中型长200*宽40*高140 300KG/层", "chinagoods")
      .providerQuery,
    "货架 加厚中型长200*宽40*高140 300KG/层"
  );
  // Una parola latina dentro una query cinese non viene tradotta.
  assert.equal(
    planSearchQuery("电源线 16AWG/1.27平方 5米 cavo", "yiwugo").providerQuery,
    "电源线 16AWG/1.27平方 5米 cavo"
  );
});
