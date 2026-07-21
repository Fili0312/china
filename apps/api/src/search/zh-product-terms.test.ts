import assert from "node:assert/strict";
import test from "node:test";
import { planSearchQuery } from "./query-planner";
import {
  titleMatchesProductType,
  translateChineseQuery,
} from "./zh-product-terms";

test("una richiesta cinese diventa una query inglese breve", () => {
  const t = translateChineseQuery("平板灯 60*60");
  assert.equal(t.english, "flat panel light 60x60");
  assert.equal(t.hasProductType, true);
  assert.deepEqual(t.requiredTerms, ["panel"]);
});

test("modelli, codici e misure non vengono tradotti", () => {
  assert.match(translateChineseQuery("电机驱动器 2HHS57-A-5/24").english, /2HHS57-A-5\/24/);
  assert.match(translateChineseQuery("螺丝 M3*5 不锈钢").english, /M3x5/);
  assert.match(translateChineseQuery("传感器 NPT0-A1").english, /NPT0-A1/);
  assert.match(translateChineseQuery("平板灯 600*600 mm").english, /600x600/);
});

test("il termine più lungo vince su quello più corto", () => {
  // 防静电台垫 è un tappetino antistatico, non un tappetino qualsiasi.
  const t = translateChineseQuery("防静电台垫 长200*宽40");
  assert.match(t.english, /table mat/);
  // «antistatico» è parte della richiesta, non un dettaglio: un tappetino
  // qualsiasi non la soddisfa.
  assert.deepEqual(t.requiredTerms, ["mat", "antistatic|esd|static"]);
});

test("un termine sconosciuto non viene inventato", () => {
  const t = translateChineseQuery("量子纠缠装置");
  assert.equal(t.hasProductType, false);
  assert.ok(t.untranslated.length > 0);
});

test("Alibaba riceve l'inglese, le fonti cinesi il testo originale", () => {
  const alibaba = planSearchQuery("平板灯 60*60", "alibaba");
  assert.equal(alibaba.providerQuery, "flat panel light 60x60");
  assert.equal(alibaba.untranslatable, null);

  const chinagoods = planSearchQuery("平板灯 60*60", "chinagoods");
  assert.equal(chinagoods.providerQuery, "平板灯 60*60");
  // I termini inglesi restano, per verificare i titoli che la fonte traduce.
  assert.deepEqual(chinagoods.requiredTerms, ["panel"]);

  const yiwugo = planSearchQuery("防静电椅 升降", "yiwugo");
  assert.equal(yiwugo.providerQuery, "防静电椅 升降");
});

test("OTAPI non è toccato: Taobao e Tmall ricevono il cinese verbatim", () => {
  for (const engine of ["taobao", "tmall"] as const) {
    const plan = planSearchQuery("平板灯 60*60", engine);
    assert.equal(plan.providerQuery, "平板灯 60*60");
    assert.equal(plan.untranslatable, null);
  }
});

test("una richiesta cinese non traducibile fa saltare il catalogo export", () => {
  const plan = planSearchQuery("量子纠缠装置", "alibaba");
  assert.ok(plan.untranslatable, "va segnalata come non traducibile");
  assert.match(plan.untranslatable!, /non traducibile/);
});

test("il tipo di prodotto distingue il pannello dalla striscia LED", () => {
  const required = translateChineseQuery("平板灯 60*60").requiredTerms;

  for (const title of [
    "LED flat panel light 600x600 mm",
    "office panel light 60x60 cm",
    "Ultra Slim Panel Lights 40W",
  ]) {
    assert.equal(
      titleMatchesProductType(title, required).matches,
      true,
      `doveva essere accettato: ${title}`
    );
  }

  for (const title of [
    "RGB LED strip 5m waterproof",
    "TV backlight kit USB",
    "Digital wall clock",
    "LED bulb E27 9W",
  ]) {
    assert.equal(
      titleMatchesProductType(title, required).matches,
      false,
      `doveva essere escluso: ${title}`
    );
  }
});

test("il plurale inglese non fa scartare un prodotto giusto", () => {
  assert.equal(titleMatchesProductType("ESD Chairs for lab", ["chair"]).matches, true);
  assert.equal(titleMatchesProductType("Antistatic mats", ["mat"]).matches, true);
});

test("senza tipo di prodotto riconosciuto non si esclude nulla", () => {
  // Nessun termine obbligatorio = nessun filtro: non si inventa un criterio.
  assert.equal(titleMatchesProductType("qualsiasi cosa", []).matches, true);
});

test("i pettini non superano il filtro di un tappetino antistatico", () => {
  const required = translateChineseQuery("防静电台垫 长200*宽40").requiredTerms;
  assert.equal(
    titleMatchesProductType("Air cushion comb, airbag massage comb", required)
      .matches,
    false
  );
  assert.equal(
    titleMatchesProductType("ESD antistatic table mat 200x40", required).matches,
    true
  );
});

test("le alternative di un termine valgono l'una per l'altra", () => {
  const required = translateChineseQuery("防静电台垫 长200*宽40").requiredTerms;
  // La richiesta dice esplicitamente «antistatico»: un tappetino qualsiasi
  // non la soddisfa, per quanto sia un tappetino.
  assert.equal(
    titleMatchesProductType("Customized bay window MATS, window sill MATS", required)
      .matches,
    false
  );
  for (const title of [
    "ESD table mat 200x40",
    "Antistatic rubber mat for workbench",
    "Anti-static ESD mats blue",
  ]) {
    assert.equal(
      titleMatchesProductType(title, required).matches,
      true,
      `doveva essere accettato: ${title}`
    );
  }
});

test("un titolo in un'altra lingua non viene scartato per la lingua", () => {
  // AliExpress da questo server geolocalizza e risponde in francese.
  const required = translateChineseQuery("平板灯 60*60").requiredTerms;
  for (const title of [
    "Panneau lumineux LED moderne 60x60 pour plafond",
    "Pack de 4 panneaux LED minces 60X60X2.5Cm",
    "Panel LED 60x60 luz blanca",
  ]) {
    assert.equal(
      titleMatchesProductType(title, required).matches,
      true,
      `doveva essere accettato: ${title}`
    );
  }
  // Ma un prodotto di un'altra categoria resta escluso anche in francese.
  assert.equal(
    titleMatchesProductType("Ruban LED RGB 5m", required).matches,
    false
  );
});
