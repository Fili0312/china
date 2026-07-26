import { Injectable, NotFoundException } from "@nestjs/common";
import { basename } from "node:path";
import { prisma, Prisma } from "@china/db";
import type {
  DatasetColumn,
  DatasetMapping,
  DatasetRow,
  TaobaoDatasetPreview,
  TaobaoDatasetSummary,
} from "@china/shared";
import { ALL_SHEETS, formatFromFileName, parseDataset } from "../scouting/dataset-workbook";
import { ClientService } from "./client.service";
import { t } from "../i18n/messages";

/**
 * I file dello scouting v1, sempre legati a un cliente.
 *
 * La lettura del foglio non viene riscritta: `dataset-workbook.ts` è già
 * collaudato sui fogli di richiesta reali — intestazioni su righe diverse,
 * più fogli per reparto, celle unite, link nascosti — e riscriverlo per avere
 * una tabella con un nome diverso sarebbe stato il modo più veloce di
 * ereditarne i bug senza ereditarne le correzioni.
 *
 * Quello che cambia rispetto allo scouting classico è **dove** finiscono le
 * righe (`TaobaoDataset`) e il fatto che ogni interrogazione parte dal
 * cliente.
 */
function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

@Injectable()
export class TaobaoDatasetService {
  constructor(private readonly clients: ClientService) {}

  get maxUploadBytes(): number {
    return numericEnv("SCOUTING_MAX_UPLOAD_BYTES", 25 * 1024 * 1024);
  }

  /** Carica un file per un cliente e ne salva righe e colonne riconosciute. */
  async createDataset(
    clientId: string,
    content: Buffer,
    fileName: string,
    sheet: string | undefined,
    previewLimit: number
  ): Promise<TaobaoDatasetPreview> {
    const client = await this.clients.get(clientId);

    const safeName = basename(fileName);
    const format = formatFromFileName(safeName);
    const parsed = parseDataset(content, {
      fileName: safeName,
      format,
      // Senza foglio indicato si leggono tutti: nei fogli di richiesta reali
      // le righe sono divise per reparto, e importarne uno solo lascerebbe
      // fuori la maggior parte del lavoro senza dirlo.
      sheet: sheet ?? ALL_SHEETS,
      previewLimit,
    });

    const dataset = await prisma.taobaoDataset.create({
      data: {
        clientId: client.clientId,
        fileName: safeName,
        format,
        sheetName: parsed.sheet,
        sizeBytes: content.length,
        headerRowNumber: parsed.headerRowNumber,
        columns: toJson(parsed.columns),
        mapping: toJson(parsed.suggestedMapping),
        rowCount: parsed.rows.length,
        warnings: parsed.warnings,
        rows: {
          create: parsed.rows.map((row) => ({
            rowNumber: row.rowNumber,
            sheetName: row.sheetName,
            sheetRowNumber: row.sheetRowNumber,
            cells: toJson(row.cells),
            hyperlink: row.hyperlink,
          })),
        },
      },
      select: { id: true, createdAt: true },
    });

    return {
      datasetId: dataset.id,
      clientId: client.clientId,
      fileName: safeName,
      format,
      sheet: parsed.sheet,
      totalRows: parsed.rows.length,
      createdAt: dataset.createdAt.toISOString(),
      analysisRunCount: 0,
      jobCount: 0,
      headerRowNumber: parsed.headerRowNumber,
      columns: parsed.columns,
      rows: parsed.previewRows,
      suggestedMapping: parsed.suggestedMapping,
      warnings: parsed.warnings,
    };
  }

  /** File di un cliente, dal più recente. */
  async list(clientId: string, limit = 50): Promise<TaobaoDatasetSummary[]> {
    await this.clients.get(clientId);
    const datasets = await prisma.taobaoDataset.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { _count: { select: { analysisRuns: true, jobs: true } } },
    });

    return datasets.map((dataset) => ({
      datasetId: dataset.id,
      clientId: dataset.clientId,
      fileName: dataset.fileName,
      format: dataset.format,
      sheet: dataset.sheetName,
      totalRows: dataset.rowCount,
      createdAt: dataset.createdAt.toISOString(),
      analysisRunCount: dataset._count.analysisRuns,
      jobCount: dataset._count.jobs,
    }));
  }

  /**
   * Anteprima di un file già caricato.
   *
   * `clientId` non è facoltativo: è il controllo di appartenenza, e renderlo
   * opzionale avrebbe reso possibile dimenticarlo in una chiamata.
   */
  async getDataset(
    clientId: string,
    datasetId: string,
    previewLimit: number
  ): Promise<TaobaoDatasetPreview> {
    const dataset = await prisma.taobaoDataset.findUnique({
      where: { id: datasetId },
      include: {
        rows: { orderBy: { rowNumber: "asc" }, take: previewLimit },
        _count: { select: { analysisRuns: true, jobs: true } },
      },
    });
    if (!dataset) throw new NotFoundException(t("err.datasetNotFound", { id: datasetId }));
    this.clients.assertOwnership(clientId, dataset.clientId, "resource.file");

    return {
      datasetId: dataset.id,
      clientId: dataset.clientId,
      fileName: dataset.fileName,
      format: dataset.format,
      sheet: dataset.sheetName,
      totalRows: dataset.rowCount,
      createdAt: dataset.createdAt.toISOString(),
      analysisRunCount: dataset._count.analysisRuns,
      jobCount: dataset._count.jobs,
      headerRowNumber: dataset.headerRowNumber,
      columns: dataset.columns as unknown as DatasetColumn[],
      rows: dataset.rows.map((row) => ({
        rowNumber: row.rowNumber,
        sheetName: row.sheetName,
        sheetRowNumber: row.sheetRowNumber,
        cells: row.cells as unknown as string[],
        hyperlink: row.hyperlink,
      })),
      suggestedMapping: (dataset.mapping as unknown as DatasetMapping[] | null) ?? [],
      warnings: dataset.warnings,
    };
  }

  /** Colonne e righe nel formato usato dalla normalizzazione. */
  async loadRows(
    datasetId: string
  ): Promise<{
    clientId: string;
    fileName: string;
    columns: DatasetColumn[];
    columnIndexes: number[];
    rows: DatasetRow[];
  }> {
    const dataset = await prisma.taobaoDataset.findUnique({
      where: { id: datasetId },
      select: { clientId: true, fileName: true, columns: true },
    });
    if (!dataset) throw new NotFoundException(t("err.datasetNotFound", { id: datasetId }));

    const columns = dataset.columns as unknown as DatasetColumn[];
    const rows = await prisma.taobaoDatasetRow.findMany({
      where: { datasetId },
      orderBy: { rowNumber: "asc" },
    });

    return {
      clientId: dataset.clientId,
      fileName: dataset.fileName,
      columns,
      columnIndexes: columns.map((column) => column.index),
      rows: rows.map((row) => ({
        rowNumber: row.rowNumber,
        sheetName: row.sheetName,
        sheetRowNumber: row.sheetRowNumber,
        cells: row.cells as unknown as string[],
        hyperlink: row.hyperlink,
      })),
    };
  }

  /** Salva la mappatura confermata dall'utente. */
  async saveMapping(
    clientId: string,
    datasetId: string,
    mapping: readonly DatasetMapping[]
  ): Promise<void> {
    const dataset = await prisma.taobaoDataset.findUnique({
      where: { id: datasetId },
      select: { clientId: true },
    });
    if (!dataset) throw new NotFoundException(t("err.datasetNotFound", { id: datasetId }));
    this.clients.assertOwnership(clientId, dataset.clientId, "resource.file");

    await prisma.taobaoDataset.update({
      where: { id: datasetId },
      data: { mapping: toJson(mapping) },
    });
  }
}
