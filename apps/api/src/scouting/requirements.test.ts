import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLanguage,
  extractModelCode,
  extractRequirements,
} from "@china/shared";

test("dimensioni etichettate in cinese", () => {
  const result = extractRequirements("防静电台垫 长200*宽40");
  assert.equal(result.dimensions.length, 200);
  assert.equal(result.dimensions.width, 40);
});

test("dimensioni posizionali senza etichette", () => {
  const result = extractRequirements("piastra 1200*600*3");
  assert.deepEqual(result.dimensions, { length: 1200, width: 600, height: 3 });
});

test("le dimensioni posizionali con unità vengono convertite", () => {
  const result = extractRequirements("pannello 1.2*0.6 m");
  assert.equal(result.dimensions.length, 1200);
  assert.equal(result.dimensions.width, 600);
});

test("una filettatura non viene letta come misura composta", () => {
  const result = extractRequirements("vite testa esagonale M8*35 不锈钢");
  assert.equal(result.requiredVariant.thread, "m8");
  assert.equal(result.dimensions.length, 35);
  assert.equal(result.dimensions.width, undefined);
  assert.equal(result.material, "acciaio inox");
});

test("potenza e tensione con unità diverse", () => {
  const kilowatt = extractRequirements("motore 1.5kW 380V");
  assert.equal(kilowatt.power, 1500);
  assert.equal(kilowatt.voltage, 380);

  const watt = extractRequirements("motore 1500W 380V");
  assert.equal(watt.power, kilowatt.power);
});

test("capacità volume e capacità di carica sono distinte", () => {
  const volume = extractRequirements("serbatoio 500ml");
  assert.equal(volume.capacity, 0.5);
  assert.equal(volume.requiredVariant.capacityUnit, "l");

  const charge = extractRequirements("power bank 10000mAh");
  assert.equal(charge.capacity, 10);
  assert.equal(charge.requiredVariant.capacityUnit, "Ah");
});

test("il grado di protezione IP diventa un requisito obbligatorio", () => {
  const result = extractRequirements("scatola derivazione IP65");
  assert.equal(result.requiredVariant.protection, "ip65");
  const requirement = result.requirements.find(
    (entry) => entry.key === "variant.protection"
  );
  assert.equal(requirement?.kind, "hard");
});

test("le certificazioni sono requisiti obbligatori, il colore è una preferenza", () => {
  const result = extractRequirements("alimentatore 24V CE RoHS nero");
  assert.deepEqual(result.certifications, ["CE", "ROHS"]);
  assert.equal(result.requiredVariant.color, "nero");

  const certification = result.requirements.find(
    (entry) => entry.key === "certification.CE"
  );
  const color = result.requirements.find(
    (entry) => entry.key === "variant.color"
  );
  assert.equal(certification?.kind, "hard");
  assert.equal(color?.kind, "soft");
});

test("i materiali cinesi e italiani convergono sullo stesso valore", () => {
  assert.equal(extractRequirements("管 不锈钢 304").material, "acciaio inox");
  assert.equal(extractRequirements("tubo acciaio inox").material, "acciaio inox");
  assert.equal(extractRequirements("staffa in alluminio").material, "alluminio");
});

test("una parola che contiene un'unità non diventa una misura", () => {
  // "variante" inizia per v: senza confine sarebbe letta come 0 volt.
  const result = extractRequirements("sedia variante base 12 mesi garanzia");
  assert.equal(result.voltage, null);
  assert.equal(result.power, null);
});

test("il codice modello viene riconosciuto dentro un testo cinese", () => {
  assert.equal(extractModelCode("电机驱动器 2HHS57-A-5/24 一台"), "2HHS57-A-5/24");
  assert.equal(extractModelCode("传感器 DJM-050-485"), "DJM-050-485");
});

test("una misura non viene scambiata per un codice modello", () => {
  assert.equal(extractModelCode("cavo 220v"), null);
  assert.equal(extractModelCode("tubo 100mm"), null);
});

test("la lingua prevalente decide la vetrina del marketplace", () => {
  assert.equal(detectLanguage("防静电椅 黑色"), "zh");
  assert.equal(detectLanguage("antistatic chair black"), "en");
  assert.equal(detectLanguage("DJM-050-485"), "en");
});
