import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  DatasetWorkbookError,
  formatFromFileName,
  parseDataset,
} from "./dataset-workbook";
import { buildNormalizedRequest } from "./normalize-request";

/** Costruisce un vero file .xlsx in memoria a partire da una griglia. */
function xlsxBuffer(rows: unknown[][], sheetName = "Foglio1"): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function csvBuffer(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

const options = { fileName: "test", previewLimit: 10 } as const;

test("riconosce le estensioni supportate e rifiuta le altre", () => {
  assert.equal(formatFromFileName("richieste.xlsx"), "xlsx");
  assert.equal(formatFromFileName("STORICO.XLS"), "xls");
  assert.equal(formatFromFileName("lista.csv"), "csv");
  assert.throws(() => formatFromFileName("foto.pdf"), /Formato non supportato/);
});

test("legge un CSV con intestazioni italiane", () => {
  const buffer = csvBuffer(
    [
      "Descrizione,Quantità,Prezzo,Note",
      "Sedia antistatica nera,10,45.50,per reparto SMT",
      "Tappetino ESD 1200x600,4,22,,",
    ].join("\n")
  );
  const parsed = parseDataset(buffer, { ...options, format: "csv" });

  assert.equal(parsed.headerRowNumber, 1);
  const fields = parsed.columns.map((column) => column.suggestedField);
  assert.deepEqual(fields, ["name", "quantity", "targetPrice", "notes"]);
  assert.equal(parsed.rows.length, 2);
  // I valori originali restano intatti, compreso il numero di riga del file.
  assert.equal(parsed.rows[0]!.rowNumber, 2);
  assert.equal(parsed.rows[0]!.cells[0], "Sedia antistatica nera");
});

test("legge un foglio di richiesta cinese riconoscendo le colonne", () => {
  const buffer = xlsxBuffer(
    [
      ["博工 询价单"],
      [],
      ["序号", "品名", "规格型号", "申请数量", "单位", "备注"],
      ["1", "防静电椅", "黑色 升降 无靠背", "10", "把", "SMT车间"],
      ["2", "电机驱动器", "2HHS57-A-5/24", "2", "台", ""],
    ],
    "询价"
  );
  const parsed = parseDataset(buffer, { ...options, format: "xlsx" });

  assert.equal(parsed.sheet, "询价");
  // L'intestazione non è la prima riga: va cercata, non assunta.
  assert.equal(parsed.headerRowNumber, 3);
  const byHeader = new Map(
    parsed.columns.map((column) => [column.header, column.suggestedField])
  );
  assert.equal(byHeader.get("品名"), "name");
  assert.equal(byHeader.get("规格型号"), "spec");
  assert.equal(byHeader.get("申请数量"), "quantity");
  assert.equal(byHeader.get("单位"), "unit");
  assert.equal(byHeader.get("备注"), "notes");
  assert.equal(parsed.rows.length, 2);
});

test("un file senza intestazione propone la colonna più descrittiva", () => {
  const buffer = xlsxBuffer([
    ["1", "Cuscinetto a sfere SKF 6204 2RS", "12"],
    ["2", "Guarnizione OR in silicone 30x2", "50"],
  ]);
  const parsed = parseDataset(buffer, { ...options, format: "xlsx" });

  const name = parsed.columns.find((column) => column.suggestedField === "name");
  assert.equal(name?.index, 1);
  assert.ok(
    parsed.warnings.some((warning) => warning.includes("nome prodotto")),
    "l'utente va avvisato che la colonna è stata indovinata"
  );
});

test("gli URL in una colonna senza intestazione diventano il link di riferimento", () => {
  const buffer = xlsxBuffer([
    ["品名", "规格型号", ""],
    ["防静电椅", "黑色", "https://detail.tmall.com/item.htm?id=123"],
  ]);
  const parsed = parseDataset(buffer, { ...options, format: "xlsx" });

  const link = parsed.columns.find(
    (column) => column.suggestedField === "referenceUrl"
  );
  assert.ok(link, "la colonna di link va riconosciuta dai valori");
  assert.equal(
    parsed.rows[0]!.hyperlink,
    "https://detail.tmall.com/item.htm?id=123"
  );
});

test("le colonne sempre vuote non vengono proposte", () => {
  const buffer = xlsxBuffer([
    ["Descrizione", "Vuota", "Quantità"],
    ["Vite M8x35 inox", "", "100"],
  ]);
  const parsed = parseDataset(buffer, { ...options, format: "xlsx" });
  // La colonna "Vuota" ha un'intestazione ma nessun dato: resta visibile
  // (l'utente potrebbe volerla mappare) ma senza campo suggerito.
  const empty = parsed.columns.find((column) => column.header === "Vuota");
  assert.equal(empty?.suggestedField, null);
  assert.equal(empty?.filledCount, 0);
});

test("un foglio inesistente produce un errore con l'elenco dei fogli", () => {
  const buffer = xlsxBuffer([["a", "b"]], "Dati");
  assert.throws(
    () => parseDataset(buffer, { ...options, format: "xlsx", sheet: "询价" }),
    (error: unknown) => {
      assert.ok(error instanceof DatasetWorkbookError);
      assert.match(error.message, /询价/);
      assert.deepEqual(error.availableSheets, ["Dati"]);
      return true;
    }
  );
});

test("la stessa richiesta in due file diversi produce la stessa impronta", () => {
  // File A: colonne cinesi, nome e specifiche separate.
  const first = parseDataset(
    xlsxBuffer([
      ["品名", "规格型号", "申请数量"],
      ["防静电椅", "黑色 升降", "10"],
    ]),
    { ...options, format: "xlsx" }
  );
  // File B: stesse informazioni, colonne in ordine diverso, parole invertite,
  // quantità diversa e una colonna amministrativa in più.
  const second = parseDataset(
    xlsxBuffer([
      ["申请部门", "申请数量", "规格型号", "品名"],
      ["物流部", "500", "升降 黑色", "防静电椅"],
    ]),
    { ...options, format: "xlsx" }
  );

  const requestA = buildNormalizedRequest(first.rows[0]!, {
    columnIndexes: first.columns.map((column) => column.index),
    mapping: first.suggestedMapping,
  });
  const requestB = buildNormalizedRequest(second.rows[0]!, {
    columnIndexes: second.columns.map((column) => column.index),
    mapping: second.suggestedMapping,
  });

  assert.equal(requestA.fingerprint, requestB.fingerprint);
  // Le quantità restano diverse: non fanno parte dell'identità.
  assert.equal(requestA.requestedQuantity, 10);
  assert.equal(requestB.requestedQuantity, 500);
});
