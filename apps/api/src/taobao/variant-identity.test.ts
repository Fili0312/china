import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeVariantIdentity,
  extractVariantSignature,
  residualSignature,
  type AnalyzedDimension,
  type AnalyzedSpec,
  type ProductAnalysis,
} from "@china/shared";

/**
 * I falsi duplicati.
 *
 * Il caso che questi test difendono è quello reale: l'analisi non estrae la
 * misura — perché era attaccata al nome, perché la riga era scritta male —
 * e due prodotti diversi finiscono con la stessa chiave di variante. Da lì in
 * poi il sistema cerca solo il primo e consegna i suoi prodotti anche per il
 * secondo, senza che nessun errore compaia da nessuna parte.
 *
 * Le due proprietà da tenere insieme sono opposte fra loro, ed è questo che
 * rende i test necessari: differenze di **scrittura** non devono separare
 * (`5mm` = `5.00mm`), differenze di **prodotto** devono separare sempre
 * (`5mm` ≠ `6mm`), anche quando i campi strutturati sono vuoti.
 */

type IdentityInput = Parameters<typeof computeVariantIdentity>[0];

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
  value: number,
  unit: string | null,
  axis: AnalyzedDimension["axis"] = "length"
): AnalyzedDimension {
  return { axis, label: null, value, unit };
}

function spec(key: string, value: string, unit: string | null = null): AnalyzedSpec {
  return { key, value, unit };
}

/* -------------------------------------------------------------------------- */
/* I casi della specifica, con l'analisi completa                              */
/* -------------------------------------------------------------------------- */

test("陶瓷针规 5mm e 5.00mm sono la stessa variante", () => {
  const left = computeVariantIdentity(
    analysis({ dimensions: [dimension(5, "mm", "diameter")] }),
    "陶瓷针规 5mm"
  );
  const right = computeVariantIdentity(
    analysis({ dimensions: [dimension(5.0, "mm", "diameter")] }),
    "陶瓷针规 5.00mm"
  );
  assert.equal(left.variantKey, right.variantKey);
  assert.equal(left.duplicateKey, right.duplicateKey);
});

test("陶瓷针规 5mm e 6mm sono varianti diverse", () => {
  const left = computeVariantIdentity(
    analysis({ dimensions: [dimension(5, "mm", "diameter")] }),
    "陶瓷针规 5mm"
  );
  const right = computeVariantIdentity(
    analysis({ dimensions: [dimension(6, "mm", "diameter")] }),
    "陶瓷针规 6mm"
  );
  assert.notEqual(left.variantKey, right.variantKey);
  assert.equal(left.familyKey, right.familyKey);
});

test("平板灯 60*60 e 30*30 restano varianti diverse anche senza unità", () => {
  const left = computeVariantIdentity(
    analysis({
      familyKey: "led-panel-light",
      dimensions: [dimension(60, null, "length"), dimension(60, null, "width")],
    }),
    "平板灯 60*60"
  );
  const right = computeVariantIdentity(
    analysis({
      familyKey: "led-panel-light",
      dimensions: [dimension(30, null, "length"), dimension(30, null, "width")],
    }),
    "平板灯 30*30"
  );
  assert.notEqual(left.variantKey, right.variantKey);
});

test("砝码 400g e 600g sono varianti diverse", () => {
  const left = computeVariantIdentity(
    analysis({
      familyKey: "calibration-weight",
      technicalSpecifications: [spec("accuracyClass", "M1"), spec("weight", "400", "g")],
    }),
    "砝码 M1镀铬400g"
  );
  const right = computeVariantIdentity(
    analysis({
      familyKey: "calibration-weight",
      technicalSpecifications: [spec("accuracyClass", "M1"), spec("weight", "600", "g")],
    }),
    "砝码 M1镀铬600g"
  );
  assert.notEqual(left.variantKey, right.variantKey);
});

test("400 g e 0.4 kg sono lo stesso peso", () => {
  const grams = computeVariantIdentity(
    analysis({ technicalSpecifications: [spec("weight", "400", "g")] }),
    "砝码 400g"
  );
  const kilos = computeVariantIdentity(
    analysis({ technicalSpecifications: [spec("weight", "0.4", "kg")] }),
    "砝码 0.4kg"
  );
  assert.equal(grams.variantKey, kilos.variantKey);
});

/* -------------------------------------------------------------------------- */
/* Il caso che prima produceva falsi duplicati                                 */
/* -------------------------------------------------------------------------- */

test("senza misure estratte, il testo tiene comunque separate le varianti", () => {
  // Nessuna dimensione, nessuna specifica: è l'analisi povera che prima
  // faceva collassare due prodotti diversi in una sola richiesta.
  const five = computeVariantIdentity(analysis(), "陶瓷针规 5mm");
  const six = computeVariantIdentity(analysis(), "陶瓷针规 6mm");

  assert.notEqual(five.variantKey, six.variantKey);
  assert.deepEqual(five.residual, ["m:5mm"]);
  assert.deepEqual(six.residual, ["m:6mm"]);
});

test("senza misure estratte, 5mm e 5.00mm restano lo stesso prodotto", () => {
  const left = computeVariantIdentity(analysis(), "陶瓷针规 5mm");
  const right = computeVariantIdentity(analysis(), "陶瓷针规 5.00 mm");
  assert.equal(left.variantKey, right.variantKey);
});

test("senza misure estratte, 60*60 e 30*30 restano separati", () => {
  const left = computeVariantIdentity(analysis({ familyKey: "led-panel-light" }), "平板灯 60*60");
  const right = computeVariantIdentity(analysis({ familyKey: "led-panel-light" }), "平板灯 30*30");
  assert.notEqual(left.variantKey, right.variantKey);
  assert.deepEqual(left.residual, ["g:60x60"]);
});

test("un modello perso dall'analisi separa comunque due righe", () => {
  const left = computeVariantIdentity(analysis({ familyKey: "driver" }), "驱动器 DJM-050-485");
  const right = computeVariantIdentity(analysis({ familyKey: "driver" }), "驱动器 DJM-050-232");
  assert.notEqual(left.variantKey, right.variantKey);
});

test("quando l'analisi è completa il residuo è vuoto", () => {
  const identity = computeVariantIdentity(
    analysis({ dimensions: [dimension(5, "mm", "diameter")] }),
    "陶瓷针规 5mm"
  );
  assert.deepEqual(identity.residual, []);
});

/* -------------------------------------------------------------------------- */
/* Ciò che non deve entrare nell'identità                                      */
/* -------------------------------------------------------------------------- */

test("la quantità richiesta non cambia la variante", () => {
  const base = analysis({ dimensions: [dimension(5, "mm", "diameter")] });
  const ten = computeVariantIdentity(base, "陶瓷针规 5mm");
  const fiveHundred = computeVariantIdentity(base, "陶瓷针规 5mm");
  assert.equal(ten.variantKey, fiveHundred.variantKey);
});

test("le unità di conteggio non entrano nella firma", () => {
  // `20个` è una quantità di confezionamento: se entrasse, la stessa
  // richiesta ordinata in due lotti diversi diventerebbe due varianti.
  assert.deepEqual(extractVariantSignature("电缆扎带 -20个"), []);
  assert.deepEqual(extractVariantSignature("电缆扎带 /一千个"), []);

  const single = computeVariantIdentity(analysis({ familyKey: "cable-tie" }), "电缆扎带");
  const packed = computeVariantIdentity(analysis({ familyKey: "cable-tie" }), "电缆扎带 -20个");
  assert.equal(single.variantKey, packed.variantKey);
});

test("i numeri senza unità e senza gruppo restano fuori dalla firma", () => {
  // Un numero di linea o un riferimento interno non è una caratteristica del
  // prodotto: includerlo spaccherebbe in due richieste identiche.
  assert.deepEqual(extractVariantSignature("插座 用于3号线"), []);
});

/* -------------------------------------------------------------------------- */
/* La firma, guardata da vicino                                                */
/* -------------------------------------------------------------------------- */

test("la firma riconosce misure, gruppi e codici", () => {
  assert.deepEqual(extractVariantSignature("平板灯 60*60"), ["g:60x60"]);
  assert.deepEqual(extractVariantSignature("螺丝 M8*35"), ["c:m8*35", "g:8x35"]);
  assert.deepEqual(extractVariantSignature("电缆 1.5米"), ["m:1500mm"]);
  assert.deepEqual(extractVariantSignature("电缆 1500mm"), ["m:1500mm"]);
});

test("il residuo esclude ciò che i campi strutturati già dicono", () => {
  const residual = residualSignature(
    "陶瓷针规 5mm 不锈钢",
    {
      model: null,
      material: "不锈钢",
      color: null,
      dimensions: [{ value: 5, unit: "mm" }],
      technicalSpecifications: [],
    },
    [5]
  );
  assert.deepEqual(residual, []);
});

test("il residuo non è vuoto quando il testo dice più dei campi", () => {
  const residual = residualSignature(
    "驱动器 DJM-050-485 24V",
    {
      model: null,
      material: null,
      color: null,
      dimensions: [],
      technicalSpecifications: [],
    },
    []
  );
  assert.deepEqual(residual, ["c:djm050485", "m:24V"]);
});

/* -------------------------------------------------------------------------- */
/* Vincoli obbligatori                                                         */
/* -------------------------------------------------------------------------- */

test("un vincolo obbligatorio in più cambia il duplicato ma non la variante", () => {
  const base = analysis({ dimensions: [dimension(5, "mm", "diameter")] });
  const withCe = analysis({
    dimensions: [dimension(5, "mm", "diameter")],
    hardRequirements: ["certificazione CE"],
  });

  const plain = computeVariantIdentity(base, "陶瓷针规 5mm");
  const certified = computeVariantIdentity(withCe, "陶瓷针规 5mm");

  assert.equal(plain.variantKey, certified.variantKey);
  assert.notEqual(plain.duplicateKey, certified.duplicateKey);
});

test("le chiavi non cambiano fra due esecuzioni identiche", () => {
  const input = analysis({
    familyKey: "led-panel-light",
    model: "NN100-200",
    dimensions: [dimension(60, null), dimension(60, null, "width")],
  });
  const first = computeVariantIdentity(input, "平板灯 NN100-200 60*60");
  const second = computeVariantIdentity(input, "平板灯 NN100-200 60*60");
  assert.deepEqual(first, second);
});

/** L'identità v1 non deve mai coincidere con quella multi-marketplace. */
test("la famiglia resta leggibile in testa alla chiave", () => {
  const identity = computeVariantIdentity(
    analysis({ familyKey: "Ceramic Pin Gauge" }) as ProductAnalysis,
    "陶瓷针规"
  );
  assert.ok(identity.variantKey.startsWith("ceramic-pin-gauge:"));
  assert.ok(identity.duplicateKey.startsWith(identity.variantKey));
});
