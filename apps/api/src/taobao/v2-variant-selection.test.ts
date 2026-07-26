import assert from "node:assert/strict";
import test from "node:test";
import type { V2RequirementContext } from "./v2-requirement-policy";
import { selectV2Variant } from "./v2-variant-selection";

function context(
  patch: Partial<V2RequirementContext> = {}
): V2RequirementContext {
  return {
    sourceText: "Sensore 24 V",
    explicit: ["constraint:24v"],
    normalized: [],
    inferred: [],
    immutableSearchTokens: ["24v"],
    immutableTextRequirements: [],
    modelTokens: [],
    quantity: { value: null, unit: null },
    ...patch,
  };
}

test("una SKU già selezionata prevale sulle opzioni della scheda", () => {
  assert.deepEqual(
    selectV2Variant(
      {
        sku: "SKU-24V",
        variants: [{ name: "Voltage", options: ["12V", "24V"] }],
      },
      context()
    ),
    {
      selectedVariant: "SKU-24V",
      requiresHumanChoice: false,
      choices: [],
    }
  );
});

test("un vincolo esplicito seleziona automaticamente una sola variante", () => {
  assert.deepEqual(
    selectV2Variant(
      {
        sku: null,
        variants: [
          { name: "Voltage", options: ["12 V", "24 V"] },
          { name: "Package", options: ["1 piece"] },
        ],
      },
      context()
    ),
    {
      selectedVariant: "Voltage: 24 V · Package: 1 piece",
      requiresHumanChoice: false,
      choices: [],
    }
  );
});

test("più opzioni non deducibili diventano una vera scelta umana", () => {
  assert.deepEqual(
    selectV2Variant(
      {
        sku: null,
        variants: [{ name: "Color", options: ["red", "blue"] }],
      },
      context({ immutableSearchTokens: [] })
    ),
    {
      selectedVariant: null,
      requiresHumanChoice: true,
      choices: ["Color: red / blue"],
    }
  );
});

test("assenza di SKU e varianti è informativa e non crea un warning", () => {
  assert.deepEqual(
    selectV2Variant({ sku: null, variants: null }, context()),
    {
      selectedVariant: null,
      requiresHumanChoice: false,
      choices: [],
    }
  );
});
