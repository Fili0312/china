import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { prisma } from "@china/db";
import {
  CRITICAL_WARNING_CODES,
  type AnswerClarificationRequest,
  type ProductAnalysis,
  type TaobaoClarification,
} from "@china/shared";
import { v2ConstraintSourceText } from "./v2-requirement-policy";
import { t } from "../i18n/messages";

/**
 * Le domande di chiarimento: poche, salvate, mai rifatte.
 *
 * Il principio è quello chiesto dall'operatore: quando all'IA «qualcosa non
 * torna» (unità di misura non capita, modello ambiguo, più prodotti in una
 * riga), il dubbio diventa una **domanda**. Le risposte restano a database e
 * vengono iniettate nelle analisi successive: la stessa domanda non viene mai
 * posta due volte.
 *
 * «Meno domande possibili» qui è struttura, non stile:
 *
 * - si domanda solo per i warning **critici** — quelli che cambierebbero quale
 *   prodotto si cerca; una riga povera ma cercabile non genera domande;
 * - dieci righe con la stessa ambiguità producono UNA domanda (`questionKey`);
 * - una domanda già risposta o archiviata non si riapre: si aggiorna solo il
 *   contatore di quante righe l'hanno incontrata.
 */

/** Quanti esempi di testo si conservano per domanda: bastano a capirla. */
const MAX_EXAMPLES = 5;

/** Quante risposte al massimo entrano nel prompt: oltre, diluiscono. */
const MAX_KNOWLEDGE_ENTRIES = 60;

/**
 * Domande nuove al massimo per ogni analisi, e domande aperte totali oltre le
 * quali non se ne aprono altre. Sono la risposta a un fatto osservato: un file
 * di prodotti nuovi ha aperto 30 domande in un colpo, e trenta domande non le
 * legge nessuno — dieci righe di dubbi valgono meno di tre dubbi ben scelti.
 */
const DEFAULT_MAX_NEW_PER_RUN = 5;
const DEFAULT_MAX_OPEN_TOTAL = 12;
export const V2_MAX_NEW_PER_PIPELINE = 2;

export type DoubtCategory =
  | "INTERNAL"
  | "TAOBAO_CHECK"
  | "ROW_REVIEW"
  | "USER_INPUT";

export interface V2QuestionCandidate {
  canonical: string;
  code: string;
  hits: number;
}

function limitEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Codici che possono diventare domande.
 *
 * `MULTIPLE_PRODUCTS` resta fuori di proposito: «quale dei due prodotti va
 * cercato?» dipende dalla riga, non dalla famiglia — la risposta giusta si dà
 * in revisione, correggendo quella riga, e salvarla come regola generale
 * insegnerebbe al sistema una risposta sbagliata per la volta dopo.
 */
const QUESTIONABLE_CODES = new Set(["AMBIGUOUS_UNIT", "AMBIGUOUS_MEASURE", "AMBIGUOUS_MODEL"]);

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function foldForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function semanticToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Attributo canonico del dubbio.
 *
 * `warning.field` arriva normalmente in inglese, ma i provider possono
 * restituire etichette localizzate. Le alias tengono la deduplicazione stabile
 * anche in quel caso. Il controllo sul codice mantiene compatibili le prime
 * righe v2, che salvavano `attributeKey = code`.
 */
export function v2AttributeKey(code: string, field?: string | null): string {
  const normalizedCode = semanticToken(code);
  const token = semanticToken(field ?? "");
  const candidate = token && token !== normalizedCode ? token : "";

  if (/(?:^|-)(?:model|modello|codice|code|型号)(?:-|$)/u.test(candidate)) return "model";
  if (/(?:^|-)(?:unit|unita|单位)(?:-|$)/u.test(candidate)) return "unit";
  if (/(?:^|-)(?:dimension|dimensions|measure|measurement|misura|misure|尺寸)(?:-|$)/u.test(candidate)) {
    return "measurement";
  }
  if (/(?:^|-)(?:quantity|quantita|数量)(?:-|$)/u.test(candidate)) return "quantity";
  if (/(?:^|-)(?:material|materiale|材料)(?:-|$)/u.test(candidate)) return "material";
  if (/(?:^|-)(?:color|colour|colore|颜色)(?:-|$)/u.test(candidate)) return "color";
  if (candidate) return candidate;

  switch (code) {
    case "AMBIGUOUS_MODEL":
      return "model";
    case "AMBIGUOUS_UNIT":
      return "unit";
    case "AMBIGUOUS_MEASURE":
      return "measurement";
    case "AMBIGUOUS_QUANTITY":
      return "quantity";
    default:
      return normalizedCode || "unknown";
  }
}

/** Tipo di decisione, separato dall'attributo e dal testo tradotto. */
export function v2DecisionKey(code: string): string {
  switch (code) {
    case "AMBIGUOUS_MODEL":
      return "allow-equivalents";
    case "AMBIGUOUS_MEASURE":
      return "required-interpretation";
    case "AMBIGUOUS_UNIT":
      return "intended-value";
    case "AMBIGUOUS_QUANTITY":
      return "intended-quantity";
    default:
      return semanticToken(code) || "manual-review";
  }
}

/**
 * Identità semantica di una domanda v2.
 *
 * Non contiene domanda, esempi, productFamily tradotta né locale: cambiare
 * lingua non crea una domanda nuova.
 */
export function v2SemanticQuestionKey(
  code: string,
  familyKey: string,
  field?: string | null
): string {
  return [
    semanticToken(familyKey) || "unknown-family",
    v2AttributeKey(code, field),
    v2DecisionKey(code),
  ].join(":");
}

/**
 * In uno stesso bucket categorie discordanti sono un segnale di classificazione
 * non abbastanza sicura. Il fallback conservativo è sempre revisione riga.
 */
export function aggregateV2DoubtCategories(
  categories: readonly DoubtCategory[]
): DoubtCategory {
  if (categories.length === 0) return "ROW_REVIEW";
  const distinct = new Set(categories);
  return distinct.size === 1 ? categories[0]! : "ROW_REVIEW";
}

/** Importanza concettuale: l'identità del prodotto precede misura e unità. */
export function v2QuestionPriority(code: string): number {
  switch (code) {
    case "AMBIGUOUS_MODEL":
      return 300;
    case "AMBIGUOUS_MEASURE":
      return 200;
    case "AMBIGUOUS_UNIT":
      return 100;
    default:
      return 0;
  }
}

/** Ordinamento puro e stabile: importanza, diffusione, poi chiave canonica. */
export function orderV2QuestionCandidates<T extends V2QuestionCandidate>(
  candidates: readonly T[]
): T[] {
  return [...candidates].sort(
    (left, right) =>
      v2QuestionPriority(right.code) - v2QuestionPriority(left.code) ||
      right.hits - left.hits ||
      left.canonical.localeCompare(right.canonical)
  );
}

/**
 * Applica insieme deduplicazione e cap totale della pipeline.
 *
 * `questionsAlreadyInPipeline` conta tutti gli status: rispondere o archiviare
 * una domanda non libera uno slot per un secondo giro nascosto.
 */
export function selectV2QuestionCandidates<T extends V2QuestionCandidate>(
  candidates: readonly T[],
  existingSemanticKeys: ReadonlySet<string>,
  questionsAlreadyInPipeline: number
): T[] {
  const remaining = Math.max(0, V2_MAX_NEW_PER_PIPELINE - questionsAlreadyInPipeline);
  if (remaining === 0) return [];
  return orderV2QuestionCandidates(
    candidates.filter((entry) => !existingSemanticKeys.has(entry.canonical))
  ).slice(0, remaining);
}

/** Nome della famiglia nella lingua della pipeline, con fallback stabili. */
export function v2FamilyLabel(
  analysis: Pick<
    ProductAnalysis,
    "productFamily" | "familyKey" | "productNameEnglish" | "productNameChinese"
  >,
  locale: string
): string {
  const preferred =
    locale === "en"
      ? analysis.productNameEnglish
      : locale === "zh"
        ? analysis.productNameChinese
        : analysis.productFamily;
  return (
    preferred?.trim() ||
    analysis.productFamily.trim() ||
    analysis.productNameEnglish?.trim() ||
    analysis.productNameChinese?.trim() ||
    analysis.familyKey
  );
}

/**
 * Testo della domanda per famiglia e tipo di dubbio.
 *
 * La domanda è **una per famiglia**, non una per misura: «i calibri a spillo
 * sono senza unità» è un dubbio solo, anche se compare su sette diametri
 * diversi. Il primo messaggio del modello entra come esempio; gli altri casi
 * stanno in `examples`.
 */
function questionFor(code: string, productFamily: string, message: string): string {
  const intro = `Famiglia «${productFamily}»`;
  const esempio = message ? ` (es.: ${message})` : "";
  switch (code) {
    case "AMBIGUOUS_UNIT":
      return `${intro}: alcune misure sono senza unità${esempio}. Che unità si usa di solito per questi pezzi (mm, cm, pollici…)?`;
    case "AMBIGUOUS_MEASURE":
      return `${intro}: una o più misure sono scritte in modo ambiguo${esempio}. Come vanno lette?`;
    case "AMBIGUOUS_MODEL":
      return `${intro}: il modello/codice non è chiaro${esempio}. Qual è il codice giusto da cercare?`;
    default:
      return `${intro}: ${message} Puoi chiarire?`;
  }
}

/**
 * Con che gesto si risponde a questo dubbio.
 *
 * Le opzioni non si inventano: derivano dal tipo di dubbio, che il sistema
 * conosce già. «Quale unità?» ha un insieme chiuso di risposte sensate e
 * merita dei pulsanti; «come vanno lette queste misure?» no, ed è giusto che
 * resti un campo di testo. Proporre opzioni dove non ce ne sono di vere
 * spingerebbe l'operatore a scegliere la meno sbagliata invece di scrivere
 * quella giusta.
 */
export function answerShapeFor(code: string): {
  options: string[];
  answerMode: "single" | "multi" | "text";
} {
  switch (code) {
    case "AMBIGUOUS_UNIT":
      return { options: ["mm", "cm", "m", "pollici"], answerMode: "single" };
    default:
      return { options: [], answerMode: "text" };
  }
}

export function localizedQuestion(
  locale: string,
  code: string,
  productFamily: string
): string {
  const family = `«${productFamily}»`;
  const copy: Record<string, Record<string, string>> = {
    it: {
      AMBIGUOUS_UNIT: `Per la famiglia ${family}, quale unità intende il cliente?`,
      AMBIGUOUS_MEASURE: `Per la famiglia ${family}, quale tolleranza o interpretazione della misura è obbligatoria?`,
      AMBIGUOUS_MODEL: `Per la famiglia ${family}, sono ammessi modelli equivalenti?`,
    },
    en: {
      AMBIGUOUS_UNIT: `For product family ${family}, which unit does the client mean?`,
      AMBIGUOUS_MEASURE: `For product family ${family}, which tolerance or measurement interpretation is mandatory?`,
      AMBIGUOUS_MODEL: `For product family ${family}, are equivalent models acceptable?`,
    },
    zh: {
      AMBIGUOUS_UNIT: `对于产品系列 ${family}，客户指的是哪一种单位？`,
      AMBIGUOUS_MEASURE: `对于产品系列 ${family}，哪种公差或尺寸解释是必须的？`,
      AMBIGUOUS_MODEL: `对于产品系列 ${family}，是否接受同等型号？`,
    },
  };
  return (copy[locale] ?? copy.it)[code] ?? (copy[locale] ?? copy.it).AMBIGUOUS_MODEL;
}

/**
 * Classificazione conservativa della v2. Un dubbio incerto non diventa mai
 * domanda: il fallback è sempre revisione della riga.
 */
export function classifyV2Doubt(
  code: string,
  submittedText: string,
  message: string,
  field?: string | null
): DoubtCategory {
  if (code === "MULTIPLE_PRODUCTS" || code === "LOW_CONFIDENCE") return "ROW_REVIEW";
  if (!QUESTIONABLE_CODES.has(code)) return "ROW_REVIEW";

  const sourceText = foldForMatch(v2ConstraintSourceText(submittedText));
  const messageText = foldForMatch(message);
  const text = `${sourceText} ${messageText}`;

  // La bassa confidenza, da sola, non è una domanda per l'utente.
  if (
    /\b(?:low confidence|confidence is low|poor confidence|bassa confidenza|confidenza bassa)\b/u.test(
      messageText
    ) ||
    /(?:低置信度|置信度低)/u.test(messageText)
  ) {
    return "ROW_REVIEW";
  }

  // Link, mapping e problemi esplicitamente locali a una riga non insegnano
  // una regola riutilizzabile alla famiglia.
  if (
    /\b(?:this row|single row|row-specific|mapping|invalid link|broken link|questa riga|singola riga|mappatura|link non valido|link errato)\b/u.test(
      messageText
    ) ||
    /(?:本行|单行|映射|链接无效|链接错误)/u.test(messageText)
  ) {
    return "ROW_REVIEW";
  }

  // Una decisione commerciale esplicita resta input utente anche se nella
  // frase compaiono parole come "variante" o "Taobao".
  if (
    /\b(?:allowed|acceptable|mandatory|preferred|equivalent models?|tolerance|client mean|client intend|ammess[ioa]|accettabil[ei]|obbligatori[oa]|preferenziale|modelli equivalenti|tolleranza|cliente intende)\b/u.test(
      messageText
    ) ||
    /(?:是否允许|是否接受|可否接受|必须|偏好|同等型号|公差|客户指)/u.test(messageText)
  ) {
    return "USER_INPUT";
  }

  // Fatti dell'inserzione: disponibilità, SKU, prezzo/unità e contenuto della
  // confezione. Gli URL vengono rimossi da foldForMatch, quindi la sola presenza
  // di un link Taobao nella riga non riclassifica ogni dubbio.
  if (
    /\b(?:sku|listing|product page|item page|availability|available|in stock|out of stock|selectable variant|selected variant|price per|priced per|included accessories?|inserzione|scheda prodotto|disponibilita|disponibile|variante selezionabile|variante selezionata|prezzo per|accessori inclusi)\b/u.test(
      text
    ) ||
    /(?:商品详情|商品页面|库存|有货|缺货|可选规格|已选规格|价格单位|单价|每件|每米|每包|每卷|配件包含|包含配件|淘宝)/u.test(
      messageText
    )
  ) {
    return "TAOBAO_CHECK";
  }

  // Se l'informazione è già scritta, la normalizzazione/analisi deve usarla:
  // non si riversa sull'utente un problema di estrazione.
  if (
    (code === "AMBIGUOUS_UNIT" || code === "AMBIGUOUS_MEASURE") &&
    (/(?:unit|unita|单位)\s*:\s*\S+/u.test(sourceText) ||
      /(?:\d+(?:[.,]\d+)?\s*(?:mm|cm|km|m|in|inch|pollici|mg|kg|g|ml|cl|l|v|w|kw|a|bar|pa|mpa|hz)\b)/u.test(
        sourceText
      ) ||
      /(?:\d+(?:[.,]\d+)?\s*(?:毫米|厘米|米|公斤|克|升|件|个|只|套|卷|包|箱|片|张))/u.test(
        sourceText
      ))
  ) {
    return "INTERNAL";
  }
  if (
    code === "AMBIGUOUS_MODEL" &&
    (/(?:model|modello|型号|code|codice)[^:\n]{0,12}[:#]\s*[\p{L}\p{N}][^\s]*/u.test(
      sourceText
    ) ||
      (v2AttributeKey(code, field) === "model" &&
        /\b[\p{L}\p{N}]{2,}[-/][\p{L}\p{N}-]{2,}\b/u.test(sourceText)))
  ) {
    return "INTERNAL";
  }

  // Una misura realmente scritta senza unità/interpretazione è uno dei pochi
  // dati tecnici che solo il cliente può conoscere. Il warning arriva qui
  // soltanto dopo il filtro v2 degli attributi realmente richiesti.
  if (
    (code === "AMBIGUOUS_UNIT" || code === "AMBIGUOUS_MEASURE") &&
    /(?:^|[^\p{L}\p{N}])\d+(?:[.,]\d+)?(?:\s*[x×*]\s*\d+(?:[.,]\d+)?){0,2}(?:[^\p{L}]|$)/u.test(
      sourceText
    )
  ) {
    return "USER_INPUT";
  }

  // Fallback conservativo richiesto dalla v2: una classificazione non
  // dimostrabile non diventa mai automaticamente una domanda.
  return "ROW_REVIEW";
}

export interface KnowledgePack {
  /** Righe pronte per il prompt: domanda + risposta. */
  entries: string[];
  /** Id delle voci usate: servono per contare gli utilizzi. */
  ids: string[];
  /** Impronta della conoscenza: entra nella chiave di cache delle analisi. */
  digest: string;
}

@Injectable()
export class ClarificationService {
  private readonly logger = new Logger("Clarifications");

  /**
   * Raccoglie le domande da un'analisi appena fatta.
   *
   * Va chiamata **dopo** aver salvato le righe: guarda le analisi effettive e
   * apre (o aggiorna) una domanda per ogni ambiguità critica non ancora
   * risolta. Restituisce quante domande nuove sono state aperte.
   */
  async harvestFromAnalysis(
    rows: ReadonlyArray<{ analysis: ProductAnalysis | null; submittedText: string }>
  ): Promise<number> {
    // Prima si raggruppa, poi si scrive: è il raggruppamento che tiene basse
    // le domande. La chiave è famiglia + tipo di dubbio, SENZA il messaggio:
    // sette diametri senza unità sulla stessa famiglia sono UN dubbio, non
    // sette domande.
    const byKey = new Map<
      string,
      { code: string; familyKey: string; question: string; examples: string[]; hits: number }
    >();

    for (const row of rows) {
      const analysis = row.analysis;
      if (!analysis) continue;
      for (const warning of analysis.warnings) {
        if (!(CRITICAL_WARNING_CODES as readonly string[]).includes(warning.code)) continue;
        if (!QUESTIONABLE_CODES.has(warning.code)) continue;

        const key = `${warning.code}:${normalize(analysis.familyKey)}`;
        const bucket = byKey.get(key);
        if (bucket) {
          bucket.hits += 1;
          if (bucket.examples.length < MAX_EXAMPLES) bucket.examples.push(row.submittedText);
          continue;
        }
        byKey.set(key, {
          code: warning.code,
          familyKey: analysis.familyKey,
          question: questionFor(warning.code, analysis.productFamily, warning.message),
          examples: [row.submittedText],
          hits: 1,
        });
      }
    }
    if (byKey.size === 0) return 0;

    // I dubbi già registrati (aperti, risposti o archiviati) non contano per
    // il tetto: si aggiornano solo i contatori. Le domande NUOVE entrano in
    // ordine di righe colpite, e solo finché i due tetti lo permettono.
    const existing = await prisma.taobaoClarification.findMany({
      where: { questionKey: { in: [...byKey.keys()] } },
      select: { id: true, questionKey: true, examples: true },
    });
    const existingByKey = new Map(existing.map((entry) => [entry.questionKey, entry]));

    for (const [questionKey, entry] of byKey) {
      const found = existingByKey.get(questionKey);
      if (!found) continue;
      await prisma.taobaoClarification.update({
        where: { id: found.id },
        data: {
          hitCount: { increment: entry.hits },
          examples: [...new Set([...found.examples, ...entry.examples])].slice(0, MAX_EXAMPLES),
        },
      });
    }

    const maxNew = limitEnv("TAOBAO_MAX_NEW_QUESTIONS", DEFAULT_MAX_NEW_PER_RUN);
    const maxOpen = limitEnv("TAOBAO_MAX_OPEN_QUESTIONS", DEFAULT_MAX_OPEN_TOTAL);
    const openNow = await prisma.taobaoClarification.count({
      // Anche il cap legacy resta isolato: domande aperte in pipeline v2 non
      // consumano gli slot della v1.
      where: { status: "OPEN", clientId: null, pipelineId: null },
    });

    const candidates = [...byKey.entries()]
      .filter(([questionKey]) => !existingByKey.has(questionKey))
      .sort(([, a], [, b]) => b.hits - a.hits)
      .slice(0, Math.max(0, Math.min(maxNew, maxOpen - openNow)));

    let opened = 0;
    for (const [questionKey, entry] of candidates) {
      await prisma.taobaoClarification.create({
        data: {
          questionKey,
          source: "analysis",
          code: entry.code,
          familyKey: entry.familyKey,
          question: entry.question,
          examples: entry.examples.slice(0, MAX_EXAMPLES),
          ...answerShapeFor(entry.code),
          hitCount: entry.hits,
        },
      });
      opened += 1;
    }

    const skipped = byKey.size - existingByKey.size - opened;
    if (opened > 0 || skipped > 0) {
      this.logger.log(
        `domande dall'analisi: ${opened} aperte` +
          (skipped > 0 ? `, ${skipped} trattenute dal tetto (${maxNew}/analisi, ${maxOpen} aperte)` : "")
      );
    }
    return opened;
  }

  /**
   * Raccolta specifica della v2: scope obbligatorio, massimo due domande,
   * una per famiglia/attributo, e nessuna domanda per dubbi di singola riga.
   */
  async harvestForPipeline(scope: {
    clientId: string;
    pipelineId: string;
    datasetId: string;
    analysisRunId: string;
    locale: string;
    rows: ReadonlyArray<{ analysis: ProductAnalysis | null; submittedText: string }>;
  }): Promise<number> {
    const buckets = new Map<
      string,
      {
        code: string;
        familyKey: string;
        family: string;
        attributeKey: string;
        examples: string[];
        hits: number;
        categories: DoubtCategory[];
      }
    >();

    for (const row of scope.rows) {
      if (!row.analysis) continue;
      for (const warning of row.analysis.warnings) {
        const category = classifyV2Doubt(
          warning.code,
          row.submittedText,
          warning.message,
          warning.field
        );
        const attributeKey = v2AttributeKey(warning.code, warning.field);
        const canonical = v2SemanticQuestionKey(
          warning.code,
          row.analysis.familyKey,
          attributeKey
        );
        const found = buckets.get(canonical);
        if (found) {
          found.hits += 1;
          found.categories.push(category);
          if (found.examples.length < MAX_EXAMPLES) found.examples.push(row.submittedText);
        } else {
          buckets.set(canonical, {
            code: warning.code,
            familyKey: row.analysis.familyKey,
            family: v2FamilyLabel(row.analysis, scope.locale),
            attributeKey,
            examples: [row.submittedText],
            hits: 1,
            categories: [category],
          });
        }
      }
    }

    const prepared = [...buckets.entries()]
      .map(([canonical, entry]) => ({
        ...entry,
        canonical,
        category: aggregateV2DoubtCategories(entry.categories),
      }))
      // Anche una sola riga può contenere una decisione davvero essenziale.
      // La deduplicazione limita il rumore; richiedere almeno due occorrenze
      // faceva invece sparire proprio le domande legittime dei file piccoli.
      .filter((entry) => entry.category === "USER_INPUT");

    if (prepared.length === 0) return 0;

    // Qualunque stato equivalente dello stesso cliente vince, anche se vive in
    // un'altra pipeline: non blocca questa corsa e non viene duplicato. Il cap
    // invece è proprio della pipeline corrente e conta tutti gli status.
    const [previous, questionsAlreadyInPipeline] = await Promise.all([
      prisma.taobaoClarification.findMany({
        where: { clientId: scope.clientId, pipelineId: { not: null } },
        select: {
          code: true,
          familyKey: true,
          attributeKey: true,
        },
      }),
      prisma.taobaoClarification.count({
        where: { clientId: scope.clientId, pipelineId: scope.pipelineId },
      }),
    ]);
    const existingSemanticKeys = new Set(
      previous.map((entry) =>
        v2SemanticQuestionKey(
          entry.code ?? "",
          entry.familyKey ?? "",
          entry.attributeKey
        )
      )
    );
    const candidates = selectV2QuestionCandidates(
      prepared,
      existingSemanticKeys,
      questionsAlreadyInPipeline
    );

    let opened = 0;
    for (const entry of candidates) {
      // Chiave client+semantica, senza pipeline né lingua: il vincolo unique
      // chiude anche la rara gara fra due pipeline concorrenti dello stesso
      // cliente. La domanda resta comunque associata solo alla pipeline che
      // riesce a crearla.
      const questionKey = `v2:${scope.clientId}:${entry.canonical}`;
      try {
        await prisma.taobaoClarification.create({
          data: {
            questionKey,
            source: "analysis",
            code: entry.code,
            familyKey: entry.familyKey,
            attributeKey: entry.attributeKey,
            category: entry.category,
            priority: v2QuestionPriority(entry.code),
            question: localizedQuestion(scope.locale, entry.code, entry.family),
            examples: [...new Set(entry.examples)].slice(0, MAX_EXAMPLES),
            hitCount: entry.hits,
            clientId: scope.clientId,
            pipelineId: scope.pipelineId,
            datasetId: scope.datasetId,
            analysisRunId: scope.analysisRunId,
            locale: scope.locale,
          },
        });
        opened += 1;
      } catch (error) {
        // P2002: un'altra pipeline dello stesso cliente ha creato nel frattempo
        // la stessa identità semantica. Non è un errore di questa pipeline.
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
    }
    return opened;
  }

  async listForPipeline(
    clientId: string,
    pipelineId: string,
    status: "OPEN" | "ANSWERED" | "DISMISSED" = "OPEN"
  ): Promise<TaobaoClarification[]> {
    const rows = await prisma.taobaoClarification.findMany({
      where: { clientId, pipelineId, status },
      orderBy: [{ priority: "desc" }, { hitCount: "desc" }, { createdAt: "asc" }],
      take: V2_MAX_NEW_PER_PIPELINE,
    });
    return rows.map((row) => this.toContract(row));
  }

  async answerForPipeline(
    clientId: string,
    pipelineId: string,
    clarificationId: string,
    input: AnswerClarificationRequest
  ): Promise<TaobaoClarification> {
    const owned = await prisma.taobaoClarification.findFirst({
      where: { id: clarificationId, clientId, pipelineId },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException(t("err.clarificationNotFound", { id: clarificationId }));
    }
    return this.applyAnswer(clarificationId, input);
  }

  async knowledgeForClient(clientId: string): Promise<KnowledgePack> {
    const answered = await prisma.taobaoClarification.findMany({
      where: { clientId, pipelineId: { not: null }, status: "ANSWERED" },
      orderBy: [{ priority: "desc" }, { answeredAt: "desc" }],
      take: MAX_KNOWLEDGE_ENTRIES,
      select: { id: true, familyKey: true, question: true, answer: true },
    });
    const entries = answered.map(
      (row) => `${row.familyKey ? `[${row.familyKey}] ` : ""}D: ${row.question} R: ${row.answer}`
    );
    const digest = answered.length
      ? shortHash(answered.map((row) => `${row.id}=${normalize(row.answer ?? "")}`).join("|"))
      : "";
    return { entries, ids: answered.map((row) => row.id), digest };
  }

  /** Apre (o aggiorna) una domanda nata dalla verifica di coerenza. */
  async upsertVerifyQuestion(
    familyKey: string | null,
    question: string,
    example: string
  ): Promise<boolean> {
    const questionKey = ["verify", normalize(familyKey ?? ""), shortHash(normalize(question))].join(":");
    const existing = await prisma.taobaoClarification.findUnique({
      where: { questionKey },
      select: { id: true, examples: true },
    });
    if (existing) {
      await prisma.taobaoClarification.update({
        where: { id: existing.id },
        data: {
          hitCount: { increment: 1 },
          examples: [...new Set([...existing.examples, example])].slice(0, MAX_EXAMPLES),
        },
      });
      return false;
    }
    await prisma.taobaoClarification.create({
      data: {
        questionKey,
        source: "verify",
        familyKey,
        question,
        examples: [example],
      },
    });
    return true;
  }

  /** Le domande, dalle più incontrate: è l'ordine giusto in cui rispondere. */
  async list(status?: "OPEN" | "ANSWERED" | "DISMISSED", limit = 100): Promise<TaobaoClarification[]> {
    const rows = await prisma.taobaoClarification.findMany({
      // Endpoint legacy/v1: le domande v2 passano esclusivamente dagli endpoint
      // client+pipeline e non devono mai comparire in questo elenco globale.
      where: status
        ? { status, clientId: null, pipelineId: null }
        : { clientId: null, pipelineId: null },
      orderBy: [{ status: "asc" }, { hitCount: "desc" }, { createdAt: "desc" }],
      take: limit,
    });
    return rows.map((row) => this.toContract(row));
  }

  /** Risponde o archivia una domanda. */
  async answer(
    clarificationId: string,
    input: AnswerClarificationRequest
  ): Promise<TaobaoClarification> {
    const existing = await prisma.taobaoClarification.findUnique({
      where: { id: clarificationId },
    });
    if (!existing) throw new NotFoundException(t("err.clarificationNotFound", { id: clarificationId }));
    if (existing.pipelineId || existing.clientId) {
      // Una domanda v2 può essere mutata solo dopo la verifica congiunta di
      // clientId e pipelineId fatta da answerForPipeline.
      throw new NotFoundException(t("err.clarificationNotFound", { id: clarificationId }));
    }
    return this.applyAnswer(clarificationId, input);
  }

  private async applyAnswer(
    clarificationId: string,
    input: AnswerClarificationRequest
  ): Promise<TaobaoClarification> {
    if (input.dismiss) {
      const updated = await prisma.taobaoClarification.update({
        where: { id: clarificationId },
        data: { status: "DISMISSED" },
      });
      return this.toContract(updated);
    }

    const answer = input.answer?.trim();
    if (!answer) {
      throw new BadRequestException(t("err.clarificationNeedsAnswer"));
    }
    const updated = await prisma.taobaoClarification.update({
      where: { id: clarificationId },
      data: { answer, status: "ANSWERED", answeredAt: new Date() },
    });
    return this.toContract(updated);
  }

  /**
   * La conoscenza da iniettare in un'analisi: tutte le risposte date.
   *
   * Il `digest` fa parte della chiave di cache delle analisi: una risposta
   * nuova produce analisi nuove per le righe che ne avevano bisogno, mentre le
   * righe senza ambiguità continuano a riusare la cache.
   */
  async knowledge(): Promise<KnowledgePack> {
    const answered = await prisma.taobaoClarification.findMany({
      // La conoscenza legacy resta quella legacy: preferenze client-scoped della
      // v2 non possono cambiare prompt, cache o risultati della v1.
      where: { status: "ANSWERED", clientId: null, pipelineId: null },
      orderBy: [{ hitCount: "desc" }, { answeredAt: "desc" }],
      take: MAX_KNOWLEDGE_ENTRIES,
      select: { id: true, familyKey: true, question: true, answer: true },
    });

    const entries = answered.map((row) => {
      const scope = row.familyKey ? `[${row.familyKey}] ` : "";
      return `${scope}D: ${row.question} R: ${row.answer}`;
    });
    const digest =
      answered.length === 0
        ? ""
        : shortHash(answered.map((row) => `${row.id}=${normalize(row.answer ?? "")}`).join("|"));

    return { entries, ids: answered.map((row) => row.id), digest };
  }

  /** Registra che una passata ha usato queste risposte. */
  async markApplied(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await prisma.taobaoClarification.updateMany({
      where: { id: { in: [...ids] } },
      data: { timesApplied: { increment: 1 } },
    });
  }

  private toContract(row: {
    id: string;
    source: string;
    code: string | null;
    familyKey: string | null;
    question: string;
    answer: string | null;
    status: string;
    examples: string[];
    options?: string[] | null;
    answerMode?: string | null;
    hitCount: number;
    timesApplied: number;
    createdAt: Date;
    answeredAt: Date | null;
  }): TaobaoClarification {
    return {
      clarificationId: row.id,
      source: row.source === "verify" ? "verify" : "analysis",
      code: row.code,
      familyKey: row.familyKey,
      question: row.question,
      answer: row.answer,
      status:
        row.status === "ANSWERED" || row.status === "DISMISSED" ? row.status : "OPEN",
      examples: row.examples,
      options: row.options ?? [],
      answerMode:
        row.answerMode === "single" || row.answerMode === "multi" ? row.answerMode : "text",
      hitCount: row.hitCount,
      timesApplied: row.timesApplied,
      createdAt: row.createdAt.toISOString(),
      answeredAt: row.answeredAt?.toISOString() ?? null,
    };
  }
}
