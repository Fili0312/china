import { prisma, Prisma } from "@china/db";
import type { NormalizedProduct } from "@china/shared";
import { createHash } from "node:crypto";

/**
 * Salvataggio permanente dei prodotti trovati.
 *
 * I candidati appartengono alla **richiesta**, non al job: è questo che
 * permette a una riga uguale, in un altro file o mesi dopo, di ritrovare i
 * prodotti già noti invece di ricercarli. Per lo stesso motivo qui non si
 * cancella mai nulla: un prodotto sparito dai risultati resta a database e
 * viene semmai marcato come non più disponibile.
 *
 * Ogni salvataggio confronta i dati commerciali con quelli precedenti: se
 * qualcosa è cambiato si registra uno snapshot e si annota **quali** campi
 * sono cambiati, che è la base sia dello storico prezzi sia della regola
 * «ricalcola il punteggio solo per i prodotti con dati modificati».
 */

/** Campi che, cambiando, rendono il prodotto "diverso" da prima. */
const TRACKED_FIELDS = [
  "title",
  "price",
  "currency",
  "moq",
  "stock",
  "rating",
  "reviewCount",
  "vendorName",
  "unavailable",
] as const;

type TrackedField = (typeof TRACKED_FIELDS)[number];

export interface CandidateData {
  engine: string;
  externalId: string;
  title: string;
  url: string | null;
  imageUrl: string | null;
  vendorName: string | null;
  vendorUrl: string | null;
  price: number | null;
  currency: string | null;
  moq: number | null;
  stock: number | null;
  rating: number | null;
  reviewCount: number | null;
  totalSales: number | null;
  relevanceScore: number | null;
  matchReasons: string[];
  matchWarnings: string[];
  unavailable: boolean;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/** Numero intero o `null`: i marketplace restituiscono anche decimali. */
function toInt(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/** Un prodotto della ricerca diventa un candidato salvabile. */
export function toCandidateData(
  product: NormalizedProduct,
  engine: string
): CandidateData {
  return {
    engine,
    externalId: product.id,
    title: product.title,
    url: product.productUrl,
    imageUrl: product.imageUrl,
    vendorName: product.vendorName,
    vendorUrl: null,
    price: product.originalPrice,
    currency: product.currency || null,
    moq: toInt(product.moq),
    // Stock e varianti arrivano dalla scheda prodotto, non dalla ricerca:
    // restano nulli finché non viene scaricato il dettaglio.
    stock: null,
    rating: product.rating ?? null,
    reviewCount: toInt(product.reviewCount ?? null),
    totalSales: toInt(product.totalSales),
    relevanceScore: product.relevanceScore ?? null,
    matchReasons: product.matchReasons ?? [],
    matchWarnings: product.matchWarnings ?? [],
    unavailable: false,
  };
}

/**
 * Impronta dei dati commerciali. Volutamente esclude immagini, punteggi di
 * pertinenza e motivazioni: cambiano per motivi nostri, non del venditore, e
 * non devono far risultare "modificato" un prodotto fermo da mesi.
 */
export function candidateContentHash(data: CandidateData): string {
  const tracked: Record<string, unknown> = {};
  for (const field of TRACKED_FIELDS) tracked[field] = data[field];
  return createHash("sha256")
    .update(JSON.stringify(tracked))
    .digest("hex")
    .slice(0, 32);
}

function changedFieldsBetween(
  previous: Record<TrackedField, unknown>,
  next: CandidateData
): string[] {
  const changed: string[] = [];
  for (const field of TRACKED_FIELDS) {
    const before = previous[field];
    const after = next[field];
    // I Decimal di Prisma non sono confrontabili con ===.
    if (String(before ?? "") !== String(after ?? "")) changed.push(field);
  }
  return changed;
}

export interface PersistCandidatesResult {
  created: number;
  updated: number;
  unchanged: number;
  changedCandidateIds: string[];
}

/**
 * Salva o aggiorna i candidati di una richiesta per un marketplace.
 *
 * @param foundQuery query che ha fatto emergere questi prodotti: viene
 * conservata sul candidato per sapere perché è stato trovato e per poter
 * rieseguire la stessa ricerca in fase di aggiornamento.
 */
export async function persistCandidates(
  requestId: string,
  foundQuery: string,
  candidates: readonly CandidateData[]
): Promise<PersistCandidatesResult> {
  const result: PersistCandidatesResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    changedCandidateIds: [],
  };

  for (const data of candidates) {
    const contentHash = candidateContentHash(data);
    const existing = await prisma.productCandidateRecord.findUnique({
      where: {
        requestId_engine_externalId: {
          requestId,
          engine: data.engine,
          externalId: data.externalId,
        },
      },
    });

    const common = {
      url: data.url,
      title: data.title,
      imageUrl: data.imageUrl,
      vendorName: data.vendorName,
      vendorUrl: data.vendorUrl,
      price: data.price == null ? null : new Prisma.Decimal(data.price),
      currency: data.currency,
      moq: data.moq,
      stock: data.stock,
      rating: data.rating,
      reviewCount: data.reviewCount,
      totalSales: data.totalSales,
      relevanceScore: data.relevanceScore,
      matchReasons: data.matchReasons,
      matchWarnings: data.matchWarnings,
      unavailable: data.unavailable,
      contentHash,
      lastCheckedAt: new Date(),
    };

    if (!existing) {
      // `upsert` e non `create`: fra la lettura qui sopra e questa scrittura
      // un'altra riga può aver inserito lo stesso prodotto. Succede davvero,
      // perché due righe con la stessa variante puntano alla **stessa**
      // richiesta e vengono elaborate in parallelo: con `create` la seconda
      // faceva fallire l'intera ricerca di quella fonte con un errore di
      // vincolo univoco, buttando via anche i prodotti già trovati.
      await prisma.productCandidateRecord.upsert({
        where: {
          requestId_engine_externalId: {
            requestId,
            engine: data.engine,
            externalId: data.externalId,
          },
        },
        create: {
          requestId,
          engine: data.engine,
          externalId: data.externalId,
          foundQuery,
          changedFields: [],
          ...common,
        },
        // Ha vinto l'altra riga: i dati sono gli stessi, si aggiorna solo
        // quando è stato controllato.
        update: { lastCheckedAt: new Date() },
      });
      result.created += 1;
      continue;
    }

    if (existing.contentHash === contentHash) {
      // Niente è cambiato: si aggiorna solo la data dell'ultimo controllo,
      // così il punteggio già calcolato resta valido e non viene rifatto.
      await prisma.productCandidateRecord.update({
        where: { id: existing.id },
        data: { lastCheckedAt: new Date(), changedFields: [] },
      });
      result.unchanged += 1;
      continue;
    }

    const changedFields = changedFieldsBetween(
      {
        title: existing.title,
        price: existing.price,
        currency: existing.currency,
        moq: existing.moq,
        stock: existing.stock,
        rating: existing.rating,
        reviewCount: existing.reviewCount,
        vendorName: existing.vendorName,
        unavailable: existing.unavailable,
      },
      data
    );

    await prisma.$transaction([
      prisma.productCandidateRecord.update({
        where: { id: existing.id },
        data: { ...common, lastChangedAt: new Date(), changedFields },
      }),
      // Lo storico conserva il valore **precedente**: è quello che permette
      // di dire «costava X, ora costa Y».
      prisma.productSnapshot.create({
        data: {
          candidateId: existing.id,
          price: existing.price,
          currency: existing.currency,
          moq: existing.moq,
          stock: existing.stock,
          rating: existing.rating,
          reviewCount: existing.reviewCount,
          available: !existing.unavailable,
          contentHash: existing.contentHash,
          changedFields,
        },
      }),
    ]);
    result.updated += 1;
    result.changedCandidateIds.push(existing.id);
  }

  return result;
}

/** Candidati già salvati per una richiesta, dal più pertinente. */
export function loadCandidates(requestId: string, engines?: readonly string[]) {
  return prisma.productCandidateRecord.findMany({
    where: {
      requestId,
      ...(engines?.length ? { engine: { in: [...engines] } } : {}),
    },
    orderBy: [{ relevanceScore: "desc" }, { firstSeenAt: "asc" }],
    include: {
      snapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
    },
  });
}

export { toJson };
