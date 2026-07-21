import { Injectable, NotFoundException } from "@nestjs/common";
import { prisma, Prisma } from "@china/db";
import type {
  DatasetColumn,
  DatasetMapping,
  DatasetPreview,
  DatasetRow,
  NormalizePreviewResult,
  NormalizedRequest,
} from "@china/shared";
import { basename } from "node:path";
import {
  ALL_SHEETS,
  DatasetWorkbookError,
  formatFromFileName,
  parseDataset,
} from "./dataset-workbook";
import { buildNormalizedRequest } from "./normalize-request";

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** JSON tipizzato per Prisma senza perdere il tipo applicativo. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

@Injectable()
export class ScoutingService {
  get maxUploadBytes(): number {
    return numericEnv("SCOUTING_MAX_UPLOAD_BYTES", 25 * 1024 * 1024);
  }

  /**
   * Carica un file, ne riconosce colonne e righe e salva tutto.
   *
   * Le righe vengono conservate **per intero**: i valori originali servono
   * nell'export finale e per rileggere la richiesta se la mappatura cambia.
   */
  async createDataset(
    content: Buffer,
    fileName: string,
    sheet: string | undefined,
    previewLimit: number
  ): Promise<DatasetPreview> {
    const safeName = basename(fileName);
    const format = formatFromFileName(safeName);
    const parsed = parseDataset(content, {
      fileName: safeName,
      format,
      sheet,
      previewLimit,
    });

    const dataset = await prisma.scoutingDataset.create({
      data: {
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
      select: { id: true },
    });

    return {
      datasetId: dataset.id,
      fileName: safeName,
      format,
      sheet: parsed.sheet,
      availableSheets: parsed.availableSheets,
      headerRowNumber: parsed.headerRowNumber,
      columns: parsed.columns,
      totalRows: parsed.rows.length,
      rows: parsed.previewRows,
      suggestedMapping: parsed.suggestedMapping,
      warnings: parsed.warnings,
    };
  }

  /** Anteprima di un dataset già caricato. */
  async getDataset(
    datasetId: string,
    previewLimit: number
  ): Promise<DatasetPreview> {
    const dataset = await prisma.scoutingDataset.findUnique({
      where: { id: datasetId },
      include: {
        rows: { orderBy: { rowNumber: "asc" }, take: previewLimit },
      },
    });
    if (!dataset) {
      throw new NotFoundException(`Dataset non trovato: ${datasetId}`);
    }

    return {
      datasetId: dataset.id,
      fileName: dataset.fileName,
      format: dataset.format as DatasetPreview["format"],
      sheet: dataset.sheetName,
      // I fogli disponibili sono un'informazione del file caricato: dopo il
      // salvataggio resta solo quello letto.
      availableSheets: [dataset.sheetName],
      headerRowNumber: dataset.headerRowNumber,
      columns: dataset.columns as unknown as DatasetColumn[],
      totalRows: dataset.rowCount,
      rows: dataset.rows.map((row) => ({
        rowNumber: row.rowNumber,
        sheetName: row.sheetName,
        sheetRowNumber: row.sheetRowNumber,
        cells: row.cells as unknown as string[],
        hyperlink: row.hyperlink,
      })),
      suggestedMapping:
        (dataset.mapping as unknown as DatasetMapping[] | null) ?? [],
      warnings: dataset.warnings,
    };
  }

  /** Elenco dei dataset caricati, dal più recente. */
  async listDatasets(limit = 50) {
    const datasets = await prisma.scoutingDataset.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        fileName: true,
        format: true,
        sheetName: true,
        rowCount: true,
        createdAt: true,
        _count: { select: { jobs: true } },
      },
    });
    return datasets.map((dataset) => ({
      datasetId: dataset.id,
      fileName: dataset.fileName,
      format: dataset.format,
      sheet: dataset.sheetName,
      totalRows: dataset.rowCount,
      createdAt: dataset.createdAt.toISOString(),
      jobCount: dataset._count.jobs,
    }));
  }

  /** Salva la mappatura confermata dall'utente. */
  async saveMapping(
    datasetId: string,
    mapping: readonly DatasetMapping[]
  ): Promise<void> {
    const dataset = await prisma.scoutingDataset.findUnique({
      where: { id: datasetId },
      select: { id: true },
    });
    if (!dataset) {
      throw new NotFoundException(`Dataset non trovato: ${datasetId}`);
    }
    await prisma.scoutingDataset.update({
      where: { id: datasetId },
      data: { mapping: toJson(mapping) },
    });
  }

  /** Colonne e righe di un dataset, nel formato usato dalla normalizzazione. */
  async loadRows(
    datasetId: string,
    limit?: number
  ): Promise<{ columnIndexes: number[]; rows: DatasetRow[] }> {
    const dataset = await prisma.scoutingDataset.findUnique({
      where: { id: datasetId },
      select: { columns: true },
    });
    if (!dataset) {
      throw new NotFoundException(`Dataset non trovato: ${datasetId}`);
    }
    const columns = dataset.columns as unknown as DatasetColumn[];
    const rows = await prisma.scoutingDatasetRow.findMany({
      where: { datasetId },
      orderBy: { rowNumber: "asc" },
      ...(limit ? { take: limit } : {}),
    });

    return {
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

  /**
   * Normalizza le righe con la mappatura scelta e indica quali richieste sono
   * già state elaborate in passato.
   *
   * Il riconoscimento avviene sull'impronta, non sul numero di riga: la stessa
   * richiesta viene ritrovata anche se arriva da un altro file, in un'altra
   * posizione o scritta con le parole in ordine diverso.
   */
  async normalizePreview(
    datasetId: string,
    mapping: readonly DatasetMapping[],
    limit: number
  ): Promise<NormalizePreviewResult> {
    const { columnIndexes, rows } = await this.loadRows(datasetId);

    const normalized: NormalizedRequest[] = rows.map((row) =>
      buildNormalizedRequest(row, { columnIndexes, mapping })
    );
    const usable = normalized.filter((request) => request.issues.length === 0);

    const known = await this.findKnownRequests(
      usable.map((request) => request.fingerprint)
    );

    const requests = normalized.slice(0, limit).map((request) => {
      const match = known.get(request.fingerprint);
      return {
        ...request,
        known: Boolean(match),
        previousSearchCount: match?.searchCount ?? 0,
        lastSearchedAt: match?.lastSearchedAt?.toISOString() ?? null,
        knownCandidateCount: match?.candidateCount ?? 0,
      };
    });

    return {
      datasetId,
      totalRows: rows.length,
      normalizedRows: usable.length,
      skippedRows: normalized.length - usable.length,
      knownRows: usable.filter((request) => known.has(request.fingerprint))
        .length,
      requests,
    };
  }

  /** Richieste già elaborate, cercate per impronta. */
  async findKnownRequests(fingerprints: readonly string[]) {
    const unique = [...new Set(fingerprints)];
    if (unique.length === 0) {
      return new Map<
        string,
        { id: string; searchCount: number; lastSearchedAt: Date | null; candidateCount: number }
      >();
    }

    const found = await prisma.scoutingRequest.findMany({
      where: { fingerprint: { in: unique } },
      select: {
        id: true,
        fingerprint: true,
        searchCount: true,
        lastSearchedAt: true,
        _count: { select: { candidates: true } },
      },
    });

    return new Map(
      found.map((request) => [
        request.fingerprint,
        {
          id: request.id,
          searchCount: request.searchCount,
          lastSearchedAt: request.lastSearchedAt,
          candidateCount: request._count.candidates,
        },
      ])
    );
  }

  /**
   * Crea o aggiorna il record della richiesta.
   *
   * L'impronta è la chiave: una riga uguale in un file diverso ricade sullo
   * stesso record e ne eredita i candidati già trovati.
   */
  async upsertScoutingRequest(request: NormalizedRequest): Promise<string> {
    const common = {
      normalizedNameKey: request.normalizedNameKey,
      displayName: request.displayName,
      normalizedName: request.normalizedName,
      category: request.category,
      brand: request.brand,
      model: request.model,
      material: request.material,
      power: request.power,
      voltage: request.voltage,
      capacity: request.capacity,
      dimensions: toJson(request.dimensions),
      requiredVariant: toJson(request.requiredVariant),
      certifications: request.certifications,
      requirements: toJson(request.requirements),
      requestedQuantity: request.requestedQuantity,
      unit: request.unit,
      targetPrice: request.targetPrice,
      notes: request.notes,
      referenceUrl: request.referenceUrl,
      searchQuery: request.searchQuery,
      language: request.language,
    };

    const record = await prisma.scoutingRequest.upsert({
      where: { fingerprint: request.fingerprint },
      create: { fingerprint: request.fingerprint, ...common },
      // La quantità richiesta e le note possono cambiare fra un file e
      // l'altro senza che il prodotto cercato cambi: si tiene l'ultima.
      update: common,
      select: { id: true },
    });
    return record.id;
  }
}

export { ALL_SHEETS, DatasetWorkbookError };
