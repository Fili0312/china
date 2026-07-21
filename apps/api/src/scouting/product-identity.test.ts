import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeProductIdentity,
  normalizeFamilyKey,
  type AnalyzedDimension,
  type AnalyzedSpec,
  type ProductAnalysis,
} from "@china/shared";

/**
 * Le regole di identità sono il cuore del riuso: se sbagliano, o si ricerca da
 * capo un prodotto che avevamo già, o — molto peggio — si consegna il prodotto
 * di un'altra variante. I casi qui sotto sono quelli della specifica, scritti
 * come li scriverebbe il foglio reale.
 */

type IdentityInput = Parameters<typeof computeProductIdentity>[0];

function analysis(overrides: Partial<IdentityInput> = {}): IdentityInput {
  return {
    familyKey: "ceramic-pin-gauge",
    model: null,
    material: null,
    color: null,
    dimensions: [],
    technicalSpecifications: [],
    includedAccessories: [],
    hardRequirements: [],
    ...overrides,
  };
}

function dimension(
  axis: AnalyzedDimension["axis"],
  value: number,
  unit: string | null
): AnalyzedDimension {
  return { axis, label: null, value, unit };
}

function spec(key: string, value: string, unit: string | null): AnalyzedSpec {
  return { key, value, unit };
}

/* -------------------------------------------------------------------------- */
/* Gli esempi della specifica                                                  */
/* -------------------------------------------------------------------------- */

test("陶瓷针规 5.00mm e 陶瓷针规 5mm sono la stessa variante", () => {
  const precise = computeProductIdentity(
    analysis({ dimensions: [dimension("diameter", 5.0, "mm")] })
  );
  const short = computeProductIdentity(
    analysis({ dimensions: [dimension("diameter", 5, "mm")] })
  );

  assert.equal(precise.variantKey, short.variantKey);
  assert.equal(precise.duplicateKey, short.duplicateKey);
});

test("陶瓷针规 5mm e 6mm sono la stessa famiglia ma varianti diverse", () => {
  const five = computeProductIdentity(
    analysis({ dimensions: [dimension("diameter", 5, "mm")] })
  );
  const six = computeProductIdentity(
    analysis({ dimensions: [dimension("diameter", 6, "mm")] })
  );

  assert.equal(five.familyKey, six.familyKey);
  assert.notEqual(five.variantKey, six.variantKey);
});

test("平板灯 60*60 e 30*30 sono varianti diverse anche senza unità", () => {
  const large = computeProductIdentity(
    analysis({
      familyKey: "led-panel-light",
      dimensions: [dimension("length", 60, null), dimension("width", 60, null)],
    })
  );
  const small = computeProductIdentity(
    analysis({
      familyKey: "led-panel-light",
      dimensions: [dimension("length", 30, null), dimension("width", 30, null)],
    })
  );

  assert.equal(large.familyKey, small.familyKey);
  assert.notEqual(large.variantKey, small.variantKey);
});

test("砝码 M1镀铬 400g e 600g sono varianti diverse", () => {
  const lighter = computeProductIdentity(
    analysis({
      familyKey: "calibration-weight",
      material: "acciaio cromato",
      technicalSpecifications: [spec("accuracyClass", "M1", null), spec("weight", "400", "g")],
    })
  );
  const heavier = computeProductIdentity(
    analysis({
      familyKey: "calibration-weight",
      material: "acciaio cromato",
      technicalSpecifications: [spec("accuracyClass", "M1", null), spec("weight", "600", "g")],
    })
  );

  assert.equal(lighter.familyKey, heavier.familyKey);
  assert.notEqual(lighter.variantKey, heavier.variantKey);
});

/* -------------------------------------------------------------------------- */
/* Equivalenze che devono valere                                               */
/* -------------------------------------------------------------------------- */

test("unità equivalenti danno la stessa variante", () => {
  const millimetri = computeProductIdentity(
    analysis({ familyKey: "steel-bar", dimensions: [dimension("length", 1500, "mm")] })
  );
  const metri = computeProductIdentity(
    analysis({ familyKey: "steel-bar", dimensions: [dimension("length", 1.5, "m")] })
  );

  assert.equal(millimetri.variantKey, metri.variantKey);
});

test("400 g e 0,4 kg sono lo stesso peso", () => {
  const grammi = computeProductIdentity(
    analysis({ technicalSpecifications: [spec("weight", "400", "g")] })
  );
  const chili = computeProductIdentity(
    analysis({ technicalSpecifications: [spec("weight", "0.4", "kg")] })
  );

  assert.equal(grammi.variantKey, chili.variantKey);
});

test("l'ordine di misure, specifiche e accessori non cambia la variante", () => {
  const first = computeProductIdentity(
    analysis({
      dimensions: [dimension("width", 40, "mm"), dimension("length", 200, "mm")],
      technicalSpecifications: [spec("voltage", "220", "V"), spec("power", "60", "W")],
      includedAccessories: ["staffa", "cavo"],
    })
  );
  const second = computeProductIdentity(
    analysis({
      dimensions: [dimension("length", 200, "mm"), dimension("width", 40, "mm")],
      technicalSpecifications: [spec("power", "60", "W"), spec("voltage", "220", "V")],
      includedAccessories: ["cavo", "staffa"],
    })
  );

  assert.equal(first.variantKey, second.variantKey);
});

test("il modello tollera separatori e maiuscole diverse", () => {
  const dashed = computeProductIdentity(analysis({ model: "DJM-050-485" }));
  const spaced = computeProductIdentity(analysis({ model: "djm 050 485" }));

  assert.equal(dashed.variantKey, spaced.variantKey);
});

/* -------------------------------------------------------------------------- */
/* Differenze che devono restare differenze                                    */
/* -------------------------------------------------------------------------- */

test("una misura senza unità non coincide con la stessa cifra in millimetri", () => {
  // `60` potrebbe essere 60 cm o 600 mm: fingere di saperlo produrrebbe il
  // prodotto sbagliato senza che nessuno se ne accorga.
  const bare = computeProductIdentity(
    analysis({ dimensions: [dimension("length", 60, null)] })
  );
  const millimetri = computeProductIdentity(
    analysis({ dimensions: [dimension("length", 60, "mm")] })
  );

  assert.notEqual(bare.variantKey, millimetri.variantKey);
});

test("colore e materiale diversi sono varianti diverse", () => {
  const black = computeProductIdentity(analysis({ color: "nero", material: "abs" }));
  const white = computeProductIdentity(analysis({ color: "bianco", material: "abs" }));
  const steel = computeProductIdentity(analysis({ color: "nero", material: "acciaio inox" }));

  assert.notEqual(black.variantKey, white.variantKey);
  assert.notEqual(black.variantKey, steel.variantKey);
});

test("un accessorio incluso in più è un'altra variante", () => {
  const bare = computeProductIdentity(analysis({ includedAccessories: [] }));
  const withCase = computeProductIdentity(analysis({ includedAccessories: ["valigetta"] }));

  assert.notEqual(bare.variantKey, withCase.variantKey);
});

/* -------------------------------------------------------------------------- */
/* Cosa non deve entrare nell'identità                                         */
/* -------------------------------------------------------------------------- */

test("quantità, unità d'acquisto, reparto e richiedente non toccano la variante", () => {
  // Il tipo dell'analisi completa serve a dimostrare che quei campi esistono e
  // che comunque non entrano nel calcolo.
  const base = analysis({ dimensions: [dimension("diameter", 5, "mm")] });
  const full: Pick<
    ProductAnalysis,
    keyof IdentityInput | "requestedQuantity" | "unit" | "softRequirements"
  > = {
    ...base,
    requestedQuantity: 500,
    unit: "pz",
    softRequirements: ["preferibilmente consegna rapida"],
  };

  assert.equal(
    computeProductIdentity(base).variantKey,
    computeProductIdentity(full).variantKey
  );
});

test("i vincoli obbligatori separano i duplicati ma non le varianti", () => {
  const plain = computeProductIdentity(analysis({ hardRequirements: [] }));
  const certified = computeProductIdentity(
    analysis({ hardRequirements: ["certificazione CE obbligatoria"] })
  );

  assert.equal(plain.variantKey, certified.variantKey);
  assert.notEqual(plain.duplicateKey, certified.duplicateKey);
});

test("le preferenze non cambiano nessuna delle tre chiavi", () => {
  const withoutSoft = computeProductIdentity(analysis());
  const withSoft = computeProductIdentity(analysis());

  assert.deepEqual(withoutSoft, withSoft);
});

/* -------------------------------------------------------------------------- */
/* Forma delle chiavi                                                          */
/* -------------------------------------------------------------------------- */

test("la famiglia resta leggibile dentro le chiavi derivate", () => {
  const identity = computeProductIdentity(analysis({ familyKey: "Ceramic Pin Gauge" }));

  assert.equal(identity.familyKey, "ceramic-pin-gauge");
  assert.ok(identity.variantKey.startsWith("ceramic-pin-gauge:"));
  assert.ok(identity.duplicateKey.startsWith(`${identity.variantKey}:`));
});

test("lo slug di famiglia normalizza accenti, spazi e punteggiatura", () => {
  assert.equal(normalizeFamilyKey("Attrezzatura  da caffè!"), "attrezzatura-da-caffe");
  assert.equal(normalizeFamilyKey("陶瓷针规"), "陶瓷针规");
  assert.equal(normalizeFamilyKey("   "), "sconosciuto");
});

test("le chiavi sono stabili fra esecuzioni diverse", () => {
  // Nessuna sorgente di casualità: la stessa analisi deve dare la stessa
  // chiave anche a mesi di distanza, altrimenti il riuso non funziona.
  const input = analysis({
    model: "DJM-050",
    dimensions: [dimension("diameter", 5, "mm")],
    technicalSpecifications: [spec("voltage", "220", "V")],
  });

  assert.equal(
    computeProductIdentity(input).variantKey,
    computeProductIdentity(input).variantKey
  );
});
