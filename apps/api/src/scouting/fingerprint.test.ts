import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRequirementFingerprint,
  extractRequirements,
  normalizeProductName,
  normalizedNameKey,
  type ProductRequirementFingerprintInput,
} from "@china/shared";

/** Richiesta minima: i test sovrascrivono solo ciò che stanno verificando. */
function input(
  overrides: Partial<ProductRequirementFingerprintInput> = {}
): ProductRequirementFingerprintInput {
  return {
    category: null,
    brand: null,
    model: null,
    normalizedName: "",
    requiredVariant: {},
    dimensions: {},
    material: null,
    power: null,
    voltage: null,
    capacity: null,
    certifications: [],
    requestedQuantity: null,
    ...overrides,
  };
}

test("l'ordine delle parole non cambia l'impronta", () => {
  const first = computeRequirementFingerprint(
    input({ normalizedName: "sedia antistatica nera girevole" })
  );
  const second = computeRequirementFingerprint(
    input({ normalizedName: "nera girevole sedia antistatica" })
  );
  assert.equal(first, second);
});

test("maiuscole, punteggiatura e spazi non cambiano l'impronta", () => {
  const first = computeRequirementFingerprint(
    input({ normalizedName: "Cuscinetto  a Sfere, SKF" })
  );
  const second = computeRequirementFingerprint(
    input({ normalizedName: "cuscinetto a sfere skf" })
  );
  assert.equal(first, second);
});

test("unità equivalenti producono la stessa impronta", () => {
  const meters = extractRequirements("tubo inox 长1.5m");
  const millimeters = extractRequirements("tubo inox 长1500mm");
  assert.equal(meters.dimensions.length, 1500);
  assert.equal(millimeters.dimensions.length, 1500);

  const first = computeRequirementFingerprint(
    input({ normalizedName: "tubo inox", dimensions: meters.dimensions })
  );
  const second = computeRequirementFingerprint(
    input({ normalizedName: "tubo inox", dimensions: millimeters.dimensions })
  );
  assert.equal(first, second);
});

test("la quantità richiesta non entra nell'impronta", () => {
  const ten = computeRequirementFingerprint(
    input({ normalizedName: "vite m8", requestedQuantity: 10 })
  );
  const thousand = computeRequirementFingerprint(
    input({ normalizedName: "vite m8", requestedQuantity: 1000 })
  );
  assert.equal(ten, thousand);
});

test("l'ordine delle chiavi dei dizionari non conta", () => {
  const first = computeRequirementFingerprint(
    input({
      normalizedName: "pannello",
      dimensions: { width: 40, length: 200 },
      requiredVariant: { color: "nero", thread: "m8" },
    })
  );
  const second = computeRequirementFingerprint(
    input({
      normalizedName: "pannello",
      dimensions: { length: 200, width: 40 },
      requiredVariant: { thread: "m8", color: "nero" },
    })
  );
  assert.equal(first, second);
});

test("le certificazioni sono confrontate senza ordine né maiuscole", () => {
  const first = computeRequirementFingerprint(
    input({ normalizedName: "alimentatore", certifications: ["CE", "RoHS"] })
  );
  const second = computeRequirementFingerprint(
    input({ normalizedName: "alimentatore", certifications: ["rohs", "ce"] })
  );
  assert.equal(first, second);
});

test("misure diverse restano richieste diverse", () => {
  const first = computeRequirementFingerprint(
    input({ normalizedName: "tubo", dimensions: { length: 1500 } })
  );
  const second = computeRequirementFingerprint(
    input({ normalizedName: "tubo", dimensions: { length: 1600 } })
  );
  assert.notEqual(first, second);
});

test("capacità uguale ma unità diversa resta una richiesta diversa", () => {
  const volume = extractRequirements("serbatoio 5L");
  const charge = extractRequirements("batteria 5Ah");
  assert.equal(volume.capacity, 5);
  assert.equal(charge.capacity, 5);

  const first = computeRequirementFingerprint(
    input({
      normalizedName: "accumulatore",
      capacity: volume.capacity,
      requiredVariant: volume.requiredVariant,
    })
  );
  const second = computeRequirementFingerprint(
    input({
      normalizedName: "accumulatore",
      capacity: charge.capacity,
      requiredVariant: charge.requiredVariant,
    })
  );
  assert.notEqual(first, second);
});

test("il modello è confrontato senza separatori di formattazione", () => {
  const first = computeRequirementFingerprint(
    input({ normalizedName: "driver", model: "2HHS57-A-5/24" })
  );
  const second = computeRequirementFingerprint(
    input({ normalizedName: "driver", model: " 2hhs57-a-5/24 " })
  );
  assert.equal(first, second);
});

test("il testo cinese non viene spezzato per carattere", () => {
  // 电机 (motore) e 机电 (elettromeccanico) usano gli stessi ideogrammi: se il
  // normalizzatore li ordinasse per carattere diventerebbero la stessa cosa.
  assert.notEqual(
    computeRequirementFingerprint(input({ normalizedName: "电机 防护罩" })),
    computeRequirementFingerprint(input({ normalizedName: "机电 防护罩" }))
  );
  // L'ordine dei termini cinesi, invece, non conta.
  assert.equal(
    computeRequirementFingerprint(input({ normalizedName: "电机 防护罩" })),
    computeRequirementFingerprint(input({ normalizedName: "防护罩 电机" }))
  );
});

test("l'impronta è esadecimale a 32 caratteri", () => {
  const value = computeRequirementFingerprint(
    input({ normalizedName: "sedia antistatica" })
  );
  assert.match(value, /^[0-9a-f]{32}$/);
});

test("normalizeProductName toglie i numeri isolati e i riempitivi", () => {
  assert.equal(
    normalizeProductName("Sedia da ufficio 200 con ruote"),
    "ruote sedia ufficio"
  );
});

test("normalizedNameKey tiene solo i termini senza cifre", () => {
  assert.equal(normalizedNameKey("driver 2hhs57-a-5/24 passo passo"), "driver passo");
});
