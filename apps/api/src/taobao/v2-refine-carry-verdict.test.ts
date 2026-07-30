import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "@china/db";
import { RefineService } from "./refine.service";

/**
 * Il refine riscrive la classifica di una riga, non ciò che il giudice ha
 * visto. Un candidato che rientra identico è lo stesso prodotto, giudicato
 * sugli stessi dati: il suo verdetto deve seguirlo.
 *
 * Senza questo, nella corsa del 28/07 il refine ha azzerato ~1700 verifiche
 * in due minuti — tutte già pagate una volta e tutte da rifare.
 */

function scored(itemId: string) {
  return {
    product: { platform: "taobao", itemId, sources: ["api"], conflicts: [] },
    score: 1,
    breakdown: {},
    matchedRequirements: [],
    missingRequirements: [],
    warnings: [],
  };
}

test("un candidato che rientra nella classifica conserva il verdetto già emesso", async () => {
  const results = prisma.taobaoJobResult as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
    deleteMany: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
  };
  const originals = {
    findMany: results.findMany,
    deleteMany: results.deleteMany,
    create: results.create,
  };

  const checkedAt = new Date("2026-07-28T11:20:00Z");
  const created: Array<Record<string, unknown>> = [];

  results.findMany = async () => [
    {
      productId: "prod-giudicato",
      coherence: { verdict: "coherent", issues: [] },
      coherenceCheckedAt: checkedAt,
    },
    // Mai giudicato: non deve portarsi dietro niente.
    { productId: "prod-mai-visto", coherence: null, coherenceCheckedAt: null },
  ];
  results.deleteMany = async () => ({ count: 2 });
  results.create = async (args) => {
    created.push((args as { data: Record<string, unknown> }).data);
    return {};
  };

  try {
    const service = new RefineService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // Il risolutore di varianti: questi test non ci arrivano.
      {} as never
    );
    await (
      service as unknown as {
        writeRowResults: (
          rowId: string,
          ranked: readonly unknown[],
          productIds: Map<string, string>
        ) => Promise<void>;
      }
    ).writeRowResults(
      "row-1",
      [scored("111"), scored("222"), scored("333")],
      new Map([
        ["taobao:111", "prod-giudicato"],
        ["taobao:222", "prod-mai-visto"],
        ["taobao:333", "prod-nuovo"],
      ])
    );
  } finally {
    results.findMany = originals.findMany;
    results.deleteMany = originals.deleteMany;
    results.create = originals.create;
  }

  assert.equal(created.length, 3);

  // Il giudicato si porta dietro verdetto e data.
  assert.deepEqual(created[0]!.coherence, { verdict: "coherent", issues: [] });
  assert.equal(created[0]!.coherenceCheckedAt, checkedAt);

  // Chi non era mai stato giudicato resta da giudicare, come il prodotto
  // che entra ora: nessuno dei due deve risultare verificato.
  assert.equal(created[1]!.coherenceCheckedAt, undefined);
  assert.equal(created[2]!.coherenceCheckedAt, undefined);
});
