import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { getAdapter } from "@china/adapters";
import { prisma, Prisma } from "@china/db";
import type { PriceTierRecord } from "@china/shared";
import {
  candidateContentHash,
  type CandidateData,
} from "./candidate-store";

/**
 * Aggiornamento dei prodotti già trovati.
 *
 * Completa il ciclo del riuso: quando una richiesta è già stata elaborata non
 * si ricerca di nuovo, ma si **riaprono le pagine** dei prodotti salvati per
 * rileggere prezzo, varianti, minimo d'ordine, disponibilità e venditore.
 *
 * Due proprietà importanti:
 *
 * 1. **La scheda prodotto dice più della ricerca.** Varianti, prezzi per
 *    quantità e stock non compaiono nei risultati di ricerca: esistono solo
 *    qui. Per questo l'aggiornamento non è solo un controllo prezzi.
 * 2. **Un aggiornamento che non trova nulla non cancella il prodotto.** Se la
 *    pagina non risponde il candidato viene marcato non disponibile, con la
 *    data dell'ultimo controllo: cancellarlo perderebbe lo storico proprio
 *    quando serve.
 */

/** Fonti raggiungibili con un browser: hanno `getDetails()` implementato. */
const BROWSER_ENGINES = new Set([
  "chinagoods",
  "yiwugo",
  "made-in-china",
  "alibaba",
  "aliexpress",
]);

export interface RefreshOutcome {
  candidateId: string;
  status: "updated" | "unchanged" | "unavailable" | "unsupported" | "error";
  changedFields: string[];
  error: string | null;
}

@Injectable()
export class CandidateRefreshService {
  private readonly logger = new Logger("CandidateRefresh");

  /**
   * Riapre la pagina di un prodotto e ne aggiorna i dati.
   *
   * Restituisce sempre un esito, anche in caso di errore: un aggiornamento
   * fallito su un prodotto non deve interrompere quello degli altri.
   */
  async refreshCandidate(candidateId: string): Promise<RefreshOutcome> {
    const candidate = await prisma.productCandidateRecord.findUnique({
      where: { id: candidateId },
    });
    if (!candidate) {
      throw new NotFoundException(`Prodotto non trovato: ${candidateId}`);
    }

    if (!BROWSER_ENGINES.has(candidate.engine)) {
      // Taobao/Tmall passano da OTAPI, che non espone una scheda prodotto
      // equivalente: dichiararlo è meglio che fingere un aggiornamento.
      return {
        candidateId,
        status: "unsupported",
        changedFields: [],
        error: `La fonte ${candidate.engine} non espone una scheda prodotto aggiornabile.`,
      };
    }

    const reference = candidate.url || candidate.externalId;
    try {
      const details = await getAdapter(candidate.engine).getDetails(reference);

      const next: CandidateData = {
        engine: candidate.engine,
        externalId: candidate.externalId,
        // Il titolo **non** viene sostituito: è l'identità su cui è stata
        // calcolata la pertinenza, e alcune schede lo restituiscono tradotto
        // (Yiwugo risponde in inglese anche a un prodotto trovato in cinese).
        // Cambiarlo in silenzio invaliderebbe il punteggio senza dirlo.
        title: candidate.title || details.title,
        url: details.url || candidate.url,
        imageUrl: details.imageUrl ?? candidate.imageUrl,
        vendorName: candidate.vendorName,
        vendorUrl: candidate.vendorUrl,
        // Regola generale: una lettura mancata non è un dato cancellato.
        // Se la scheda non espone il prezzo si tiene quello che avevamo,
        // altrimenti un parser che sbaglia distruggerebbe i dati buoni.
        price: details.price?.value ?? (candidate.price == null ? null : Number(candidate.price)),
        currency: details.price?.currency ?? candidate.currency,
        moq: details.moq ?? candidate.moq,
        // Lo stock si legge dagli attributi quando la scheda lo dichiara.
        stock: readStock(details.attributes) ?? candidate.stock,
        rating: candidate.rating,
        reviewCount: candidate.reviewCount,
        totalSales: candidate.totalSales,
        relevanceScore: candidate.relevanceScore,
        matchReasons: candidate.matchReasons,
        matchWarnings: candidate.matchWarnings,
        unavailable: false,
      };

      const contentHash = candidateContentHash(next);
      const changedFields = diffFields(candidate, next);
      const priceTiers = normalizeTiers(details.priceTiers);

      // Anche i dettagli strutturali si aggiornano solo se la scheda ne ha
      // davvero restituiti: una pagina letta male non deve svuotare varianti
      // e scaglioni già noti.
      const structural: Prisma.ProductCandidateRecordUpdateInput = {};
      if (details.variants.length > 0) {
        structural.variants = details.variants as unknown as Prisma.InputJsonValue;
      }
      if (Object.keys(details.attributes).length > 0) {
        structural.specs = details.attributes as unknown as Prisma.InputJsonValue;
      }
      if (priceTiers.length > 0) {
        structural.priceTiers = priceTiers as unknown as Prisma.InputJsonValue;
      }

      if (contentHash === candidate.contentHash) {
        // Nulla di commerciale è cambiato: si aggiornano solo i dettagli
        // strutturali e la data di controllo, così il punteggio resta valido.
        await prisma.productCandidateRecord.update({
          where: { id: candidateId },
          data: {
            lastCheckedAt: new Date(),
            detailsFetchedAt: new Date(),
            changedFields: [],
            ...structural,
          },
        });
        return {
          candidateId,
          status: "unchanged",
          changedFields: [],
          error: null,
        };
      }

      await prisma.$transaction([
        prisma.productCandidateRecord.update({
          where: { id: candidateId },
          data: {
            title: next.title,
            url: next.url,
            imageUrl: next.imageUrl,
            price:
              next.price == null ? null : new Prisma.Decimal(next.price),
            currency: next.currency,
            moq: next.moq,
            stock: next.stock,
            unavailable: false,
            ...structural,
            contentHash,
            changedFields,
            lastCheckedAt: new Date(),
            lastChangedAt: new Date(),
            detailsFetchedAt: new Date(),
          },
        }),
        // Lo storico conserva i valori **precedenti**: è ciò che permette di
        // dire «costava X, ora costa Y».
        prisma.productSnapshot.create({
          data: {
            candidateId,
            price: candidate.price,
            currency: candidate.currency,
            moq: candidate.moq,
            stock: candidate.stock,
            rating: candidate.rating,
            reviewCount: candidate.reviewCount,
            available: !candidate.unavailable,
            contentHash: candidate.contentHash,
            changedFields,
          },
        }),
      ]);

      return { candidateId, status: "updated", changedFields, error: null };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Errore imprevisto";
      // Pagina irraggiungibile o prodotto rimosso: si segna come non
      // disponibile senza perdere né il record né il suo storico.
      const gone = /non trovat|not found|404|rimoss|removed|invalid/i.test(
        message
      );
      await prisma.productCandidateRecord.update({
        where: { id: candidateId },
        data: {
          lastCheckedAt: new Date(),
          ...(gone
            ? {
                unavailable: true,
                lastChangedAt: new Date(),
                changedFields: ["unavailable"],
              }
            : {}),
        },
      });
      this.logger.warn(
        `aggiornamento fallito per ${candidateId} (${candidate.engine}): ${message}`
      );
      return {
        candidateId,
        status: gone ? "unavailable" : "error",
        changedFields: gone ? ["unavailable"] : [],
        error: message.slice(0, 300),
      };
    }
  }

  /**
   * Aggiorna tutti i prodotti di una richiesta, uno alla volta.
   *
   * Sequenziale di proposito: ogni scheda è una visita al sito, e le visite
   * ravvicinate sono esattamente ciò che fa scattare i captcha.
   */
  async refreshRequest(
    requestId: string,
    options: { limit?: number; olderThanHours?: number } = {}
  ): Promise<RefreshOutcome[]> {
    const cutoff =
      options.olderThanHours != null
        ? new Date(Date.now() - options.olderThanHours * 3_600_000)
        : null;

    const candidates = await prisma.productCandidateRecord.findMany({
      where: {
        requestId,
        engine: { in: [...BROWSER_ENGINES] },
        ...(cutoff ? { lastCheckedAt: { lt: cutoff } } : {}),
      },
      orderBy: { lastCheckedAt: "asc" },
      take: options.limit ?? 20,
      select: { id: true },
    });

    const outcomes: RefreshOutcome[] = [];
    for (const candidate of candidates) {
      outcomes.push(await this.refreshCandidate(candidate.id));
    }
    return outcomes;
  }

  /** Storico dei prezzi di un prodotto, dal più recente. */
  async priceHistory(candidateId: string, limit = 50) {
    const candidate = await prisma.productCandidateRecord.findUnique({
      where: { id: candidateId },
      select: {
        id: true,
        title: true,
        price: true,
        currency: true,
        moq: true,
        stock: true,
        lastCheckedAt: true,
        lastChangedAt: true,
        unavailable: true,
      },
    });
    if (!candidate) {
      throw new NotFoundException(`Prodotto non trovato: ${candidateId}`);
    }

    const snapshots = await prisma.productSnapshot.findMany({
      where: { candidateId },
      orderBy: { capturedAt: "desc" },
      take: limit,
    });

    return {
      candidate: {
        candidateId: candidate.id,
        title: candidate.title,
        price: candidate.price == null ? null : Number(candidate.price),
        currency: candidate.currency,
        moq: candidate.moq,
        stock: candidate.stock,
        lastCheckedAt: candidate.lastCheckedAt.toISOString(),
        lastChangedAt: candidate.lastChangedAt?.toISOString() ?? null,
        unavailable: candidate.unavailable,
      },
      // Ogni voce è il valore **prima** del cambiamento indicato.
      history: snapshots.map((snapshot) => ({
        capturedAt: snapshot.capturedAt.toISOString(),
        price: snapshot.price == null ? null : Number(snapshot.price),
        currency: snapshot.currency,
        moq: snapshot.moq,
        stock: snapshot.stock,
        available: snapshot.available,
        changedFields: snapshot.changedFields,
      })),
    };
  }
}

/** Stock dichiarato negli attributi della scheda, quando c'è. */
export function readStock(
  attributes: Record<string, string> | undefined
): number | null {
  if (!attributes) return null;
  for (const [name, value] of Object.entries(attributes)) {
    if (!/stock|库存|quantit|disponibil|inventory/i.test(name)) continue;
    const match = String(value).replace(/[,\s]/g, "").match(/\d+/);
    if (!match) continue;
    const parsed = Number.parseInt(match[0], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Prezzi per quantità nel formato salvato a database. */
export function normalizeTiers(
  tiers: Array<{ minQty: number; price: { value: number; currency: string } }>
): PriceTierRecord[] {
  return tiers
    .filter((tier) => Number.isFinite(tier.minQty) && tier.minQty > 0)
    .map((tier) => ({
      minQty: Math.round(tier.minQty),
      price: tier.price.value,
      currency: tier.price.currency,
    }))
    .sort((left, right) => left.minQty - right.minQty);
}

/** Campi commerciali cambiati fra il record salvato e quello appena letto. */
export function diffFields(
  previous: {
    title: string;
    price: Prisma.Decimal | null;
    currency: string | null;
    moq: number | null;
    stock: number | null;
    vendorName: string | null;
    unavailable: boolean;
  },
  next: CandidateData
): string[] {
  const changed: string[] = [];
  const compare = (name: string, before: unknown, after: unknown) => {
    if (String(before ?? "") !== String(after ?? "")) changed.push(name);
  };
  compare("title", previous.title, next.title);
  compare("price", previous.price, next.price);
  compare("currency", previous.currency, next.currency);
  compare("moq", previous.moq, next.moq);
  compare("stock", previous.stock, next.stock);
  compare("vendorName", previous.vendorName, next.vendorName);
  compare("unavailable", previous.unavailable, next.unavailable);
  return changed;
}
