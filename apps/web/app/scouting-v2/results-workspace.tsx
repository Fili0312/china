"use client";

import {
  TAOBAO_ROW_STATUS_LABELS,
  type TaobaoPipelineGap,
  type TaobaoPipelineReviewIssue,
  type TaobaoRowResults,
  type V2RetryEstimate,
  type V2RetryMode,
  type V2RetryResult,
} from "@china/shared";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useI18n } from "../i18n/context";
import {
  buildV2ResultRows,
  calculateVirtualWindow,
  filterAndSortV2ResultRows,
  groupV2ResultRows,
  marketplaceLabel,
  type V2HumanActionType,
  type V2ResultPlatformFilter,
  type V2ResultRow,
  type V2ResultSection,
  type V2ResultSectionFilter,
  type V2ResultSort,
} from "./results-model";
import styles from "./results-workspace.module.css";

/**
 * Misure della griglia. Devono restare allineate al CSS: la virtualizzazione
 * calcola le altezze, non le misura, quindi una scheda più alta del previsto
 * lascerebbe buchi durante lo scorrimento.
 */
/** Altezza di una riga: fissa, perché la virtualizzazione la calcola. */
const LINE_HEIGHT = 64;
const SECTION_ORDER: readonly V2ResultSection[] = [
  "corrected",
  "review",
  "rejected",
  "no_result",
  "not_procurable",
  "auto_resolved",
];

const COPY = {
  it: {
    search: "Cerca per riga, prodotto, query o SKU",
    sectionFilter: "Sezione",
    platformFilter: "Marketplace",
    sort: "Ordina",
    all: "Tutte",
    allPlatforms: "Tutti",
    rowAsc: "Numero riga",
    nameAsc: "Nome A–Z",
    confidenceDesc: "Confidenza più alta",
    priceAsc: "Prezzo più basso",
    visible: "{shown} di {total}",
    clear: "Azzera filtri",
    loading: "Caricamento dei risultati fino a 1000 righe…",
    empty: "Nessuna riga corrisponde ai filtri.",
    noStoredRows: "Il job non contiene righe salvate.",
    columns: {
      product: "Richiesta",
      candidate: "Prodotto proposto",
      source: "Fonte / SKU",
      price: "Prezzo",
      confidence: "Confidenza",
      status: "Stato",
    },
    sections: {
      corrected: {
        title: "Corretti",
        hint: "Prodotto coerente, senza decisioni aperte.",
      },
      review: {
        title: "Da controllare",
        hint: "Un prodotto esiste, ma serve una decisione umana.",
      },
      rejected: {
        title: "Trovati ma scartati",
        hint: "La ricerca ha portato prodotti, la verifica li ha respinti tutti: qui c'è il perché, e se il perché non regge puoi accettarli.",
      },
      no_result: {
        title: "Nessun prodotto",
        hint: "Righe per cui la ricerca non ha portato niente.",
      },
      not_procurable: {
        title: "Non acquistabili online",
        hint: "Moduli da stampare, servizi, codici del costruttore: nessun marketplace li vende.",
      },
      auto_resolved: {
        title: "Controlli auto-risolti",
        hint: "Verifiche gestite automaticamente; sezione chiusa di default.",
      },
    },
    candidateMissing: "Nessun prodotto",
    imageMissing: "Immagine non disponibile",
    notVerified: "Non verificato",
    listLabel: "promo dichiarata dalla fonte, da verificare:",
    listPriceLabel: "prezzo di listino:",
    readAt: "letto il",
    priceNote:
      "Il prezzo è quello della variante predefinita: sulla pagina può differire se scegli un'altra variante o se è attiva una promozione diversa.",
    confirmedTitle: "Confermati",
    toConfirmTitle: "Da confermare",
    costLabel: "Costo",
    sellLabel: "Prezzo di vendita",
    showDetail: "Dettaglio",
    qtyLabel: "Da ordinare",
    priceLabel: "Prezzo",
    totalLabel: "Totale",
    retryRow: "Riprova",
    retrying: "In corso…",
    selectRow: "Scegli la riga {row}",
    retrySelected: "{chosen} righe scelte su {total}",
    retrySelectAll: "Tutte",
    retryClear: "Nessuna",
    retryModeLabel: "Come riprovare",
    retryModes: {
      rejudge: {
        title: "Rileggi i prodotti già trovati",
        hint: "Rigiudica con i criteri di oggi. Nessuna chiamata di ricerca.",
      },
      research: {
        title: "Cerca di nuovo",
        hint: "Riscrive la query dai motivi del rifiuto e ricerca. Costa chiamate.",
      },
    },
    retryPickFirst: "Scegli almeno una riga.",
    retryEstimating: "Calcolo del costo…",
    retryCost: "{rows} righe · {calls} chiamate di ricerca · ~${cost}",
    retryLaunch: "Riprova le righe scelte",
    retryDone: "{recovered} righe recuperate su {rows} · spesi ${spent}",
    triedQueries: "Query provate",
    unavailable: "Non disponibile",
    reused: "Riusato",
    candidates: "{count} candidati",
    rowStatus: "Stato job: {status}",
    details: "Dettagli riga #{row}",
    closeDetails: "Chiudi dettagli",
    query: "Query",
    original: "Valori originali",
    searchedAs: "cercato come:",
    error: "Errore",
    technicalChecks: "Controlli tecnici",
    automaticChecks: "Controlli risolti automaticamente",
    alternatives: "Altre proposte per questa riga",
    alternativesHint: "Già pagate dalla ricerca: scegliere un'altra non costa nulla. Attenzione al formato — un prezzo più basso è spesso una confezione più piccola.",
    useThis: "Usa questo",
    inUse: "In uso",
    openProduct: "Apri il prodotto",
    bell: "{count} interventi umani richiesti",
    actionTypes: {
      APPROVE_EQUIVALENT: "Approva equivalente",
      CHOOSE_VARIANT: "Scegli variante",
      CLARIFY_REQUIREMENT: "Chiarisci requisito",
      CHANGE_TOLERANCE: "Modifica tolleranza",
      MARK_UNAVAILABLE: "Segna non disponibile",
      CONFIRM_PRICE: "Leggi il prezzo sulla pagina",
    },
    acceptTitle: "Accetta questo prodotto",
    accepting: "Accetto…",
    rejectedWhy: "Perché è stato scartato",
  },
  en: {
    search: "Search by row, product, query or SKU",
    sectionFilter: "Section",
    platformFilter: "Marketplace",
    sort: "Sort",
    all: "All",
    allPlatforms: "All",
    rowAsc: "Row number",
    nameAsc: "Name A–Z",
    confidenceDesc: "Highest confidence",
    priceAsc: "Lowest price",
    visible: "{shown} of {total}",
    clear: "Clear filters",
    loading: "Loading up to 1,000 result rows…",
    empty: "No rows match the filters.",
    noStoredRows: "This job has no stored rows.",
    columns: {
      product: "Request",
      candidate: "Suggested product",
      source: "Source / SKU",
      price: "Price",
      confidence: "Confidence",
      status: "Status",
    },
    sections: {
      corrected: {
        title: "Correct",
        hint: "Coherent product with no pending decision.",
      },
      review: {
        title: "To review",
        hint: "A product exists, but a person must decide.",
      },
      rejected: {
        title: "Found but rejected",
        hint: "The search did bring products, the check rejected them all: here is why — and if the reason does not hold, you can accept them.",
      },
      no_result: {
        title: "No product",
        hint: "Rows the search brought nothing for.",
      },
      not_procurable: {
        title: "Not sold online",
        hint: "Forms to print, services, manufacturer codes: no marketplace lists them.",
      },
      auto_resolved: {
        title: "Automatically resolved checks",
        hint: "Checks handled automatically; collapsed by default.",
      },
    },
    candidateMissing: "No product",
    imageMissing: "Image unavailable",
    notVerified: "Not verified",
    listLabel: "promo declared by the source, to verify:",
    listPriceLabel: "list price:",
    readAt: "read on",
    priceNote:
      "This is the default variant price: the page may differ if you pick another variant or a different promotion is running.",
    confirmedTitle: "Confirmed",
    toConfirmTitle: "To confirm",
    costLabel: "Cost",
    sellLabel: "Selling price",
    showDetail: "Details",
    qtyLabel: "To order",
    priceLabel: "Price",
    totalLabel: "Total",
    retryRow: "Retry",
    retrying: "Running…",
    selectRow: "Select row {row}",
    retrySelected: "{chosen} of {total} rows selected",
    retrySelectAll: "All",
    retryClear: "None",
    retryModeLabel: "How to retry",
    retryModes: {
      rejudge: {
        title: "Re-read the products already found",
        hint: "Re-judges with today's criteria. No search calls.",
      },
      research: {
        title: "Search again",
        hint: "Rewrites the query from the rejection reasons. Costs calls.",
      },
    },
    retryPickFirst: "Select at least one row.",
    retryEstimating: "Estimating cost…",
    retryCost: "{rows} rows · {calls} search calls · ~${cost}",
    retryLaunch: "Retry selected rows",
    retryDone: "{recovered} of {rows} rows recovered · ${spent} spent",
    triedQueries: "Queries tried",
    unavailable: "Unavailable",
    reused: "Reused",
    candidates: "{count} candidates",
    rowStatus: "Job status: {status}",
    details: "Row #{row} details",
    closeDetails: "Close details",
    query: "Query",
    original: "Original values",
    searchedAs: "searched as:",
    error: "Error",
    technicalChecks: "Technical checks",
    automaticChecks: "Automatically resolved checks",
    alternatives: "Other options for this row",
    alternativesHint: "Already paid for by the search: picking another costs nothing. Mind the pack size — a lower price is often a smaller pack.",
    useThis: "Use this one",
    inUse: "In use",
    openProduct: "Open product",
    bell: "{count} human interventions required",
    actionTypes: {
      APPROVE_EQUIVALENT: "Approve equivalent",
      CHOOSE_VARIANT: "Choose variant",
      CLARIFY_REQUIREMENT: "Clarify requirement",
      CHANGE_TOLERANCE: "Change tolerance",
      MARK_UNAVAILABLE: "Mark unavailable",
      CONFIRM_PRICE: "Read the price on the page",
    },
    acceptTitle: "Accept this product",
    accepting: "Accepting…",
    rejectedWhy: "Why it was rejected",
  },
  zh: {
    search: "按行、产品、搜索词或 SKU 搜索",
    sectionFilter: "分区",
    platformFilter: "平台",
    sort: "排序",
    all: "全部",
    allPlatforms: "全部",
    rowAsc: "行号",
    nameAsc: "名称 A–Z",
    confidenceDesc: "置信度从高到低",
    priceAsc: "价格从低到高",
    visible: "{shown} / {total}",
    clear: "清除筛选",
    loading: "正在加载最多 1000 行结果…",
    empty: "没有符合筛选条件的行。",
    noStoredRows: "此任务没有保存的行。",
    columns: {
      product: "需求",
      candidate: "建议产品",
      source: "来源 / SKU",
      price: "价格",
      confidence: "置信度",
      status: "状态",
    },
    sections: {
      corrected: {
        title: "正确",
        hint: "产品匹配且没有待处理决定。",
      },
      review: {
        title: "待检查",
        hint: "已有产品，但需要人工决定。",
      },
      rejected: {
        title: "找到了但被否决",
        hint: "搜索有结果，但核对全部否决了：这里写明原因；理由不成立时可以直接采纳。",
      },
      no_result: {
        title: "没有产品",
        hint: "搜索没有带回任何结果的行。",
      },
      not_procurable: {
        title: "网购买不到",
        hint: "需打印的表单、服务、厂家专用编码：任何平台都不出售。",
      },
      auto_resolved: {
        title: "自动解决的检查",
        hint: "系统已自动处理；默认折叠。",
      },
    },
    candidateMissing: "没有产品",
    imageMissing: "图片不可用",
    notVerified: "未验证",
    listLabel: "来源声称的促销价，需核实：",
    listPriceLabel: "标价：",
    readAt: "读取于",
    priceNote: "此价格为默认规格价：选择其他规格或遇到不同促销时，页面价格可能不同。",
    confirmedTitle: "已确认",
    toConfirmTitle: "待确认",
    costLabel: "成本",
    sellLabel: "售价",
    showDetail: "详情",
    qtyLabel: "订购数量",
    priceLabel: "单价",
    totalLabel: "合计",
    retryRow: "重试",
    retrying: "进行中…",
    selectRow: "选择第 {row} 行",
    retrySelected: "已选 {chosen} / {total} 行",
    retrySelectAll: "全选",
    retryClear: "取消",
    retryModeLabel: "重试方式",
    retryModes: {
      rejudge: {
        title: "重新审核已找到的产品",
        hint: "按当前标准重新判定，不消耗搜索调用。",
      },
      research: {
        title: "重新搜索",
        hint: "依据被拒原因改写搜索词后再搜，会消耗调用。",
      },
    },
    retryPickFirst: "请至少选择一行。",
    retryEstimating: "正在估算费用…",
    retryCost: "{rows} 行 · {calls} 次搜索调用 · 约 ${cost}",
    retryLaunch: "重试所选行",
    retryDone: "{rows} 行中恢复 {recovered} 行 · 花费 ${spent}",
    triedQueries: "已尝试的搜索词",
    unavailable: "不可用",
    reused: "已复用",
    candidates: "{count} 个候选项",
    rowStatus: "任务状态：{status}",
    details: "第 {row} 行详情",
    closeDetails: "关闭详情",
    query: "搜索词",
    original: "原始值",
    searchedAs: "搜索用词：",
    error: "错误",
    technicalChecks: "技术检查",
    automaticChecks: "自动解决的检查",
    alternatives: "该行的其他候选",
    alternativesHint: "搜索时已经付过费：换一个不额外花钱。注意规格——价格更低往往是更小的包装。",
    useThis: "选用此项",
    inUse: "使用中",
    openProduct: "打开产品",
    bell: "需要 {count} 项人工处理",
    actionTypes: {
      APPROVE_EQUIVALENT: "批准等效产品",
      CHOOSE_VARIANT: "选择规格",
      CLARIFY_REQUIREMENT: "澄清需求",
      CHANGE_TOLERANCE: "调整容差",
      MARK_UNAVAILABLE: "标记为不可用",
      CONFIRM_PRICE: "到页面上读取价格",
    },
    acceptTitle: "采纳该产品",
    accepting: "正在采纳…",
    rejectedWhy: "被否决的原因",
  },
} as const;

interface ResultsWorkspaceProps {
  rows: readonly TaobaoRowResults[];
  /** Intestazioni del foglio, allineate a `originalCells` di ogni riga. */
  columns?: readonly string[];
  gaps?: readonly TaobaoPipelineGap[];
  reviewIssues?: readonly TaobaoPipelineReviewIssue[];
  loading?: boolean;
  loadError?: string | null;
  /** Maggiorazione da applicare al costo per ottenere il prezzo di vendita. */
  markupPct?: number;
  /**
   * Riprova le righe scelte, al gradino scelto.
   *
   * Assente quando i risultati sono storici: lì non c'è un job vivo da
   * rilanciare, e un pulsante che non fa nulla è peggio di nessun pulsante.
   */
  onRetryRows?: (
    rowNumbers: readonly number[],
    mode: V2RetryMode
  ) => Promise<V2RetryResult>;
  /** Quanto costerebbe, prima di lanciare. */
  onEstimateRetry?: (
    rowNumbers: readonly number[],
    mode: V2RetryMode
  ) => Promise<V2RetryEstimate>;
  /**
   * «Questo prodotto va bene lo stesso».
   *
   * Il giudice sbaglia in una direzione sola — è severo, e su un titolo cinese
   * povero preferisce respingere. Chi guarda la scheda lo vede in due secondi:
   * questo è il gesto che gli permette di dirlo.
   */
  onAcceptCandidate?: (rowNumber: number, productId: string) => Promise<void>;
}

export function ResultsWorkspace({
  rows,
  columns = [],
  gaps = [],
  reviewIssues = [],
  loading = false,
  loadError = null,
  markupPct = 0,
  onRetryRows,
  onEstimateRetry,
  onAcceptCandidate,
}: ResultsWorkspaceProps) {
  const { locale, intlLocale } = useI18n();
  const copy = COPY[locale];
  const [query, setQuery] = useState("");
  const [sectionFilter, setSectionFilter] =
    useState<V2ResultSectionFilter>("all");
  const [platformFilter, setPlatformFilter] =
    useState<V2ResultPlatformFilter>("all");
  const [sort, setSort] = useState<V2ResultSort>("row_asc");
  /**
   * La riprova a scala: quali righe, a quale gradino, a che prezzo.
   *
   * La stima si chiede a ogni cambio di selezione o di gradino perché è
   * l'unica cosa che rende la scelta informata: fra rigiudicare e ricercare
   * ci sono due ordini di grandezza, e vederli dopo non serve a niente.
   */
  const [chosenRows, setChosenRows] = useState<ReadonlySet<number>>(new Set());
  const [retryMode, setRetryMode] = useState<V2RetryMode>("rejudge");
  const [estimate, setEstimate] = useState<V2RetryEstimate | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryOutcome, setRetryOutcome] = useState<V2RetryResult | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [acceptingRow, setAcceptingRow] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Dove porta il campanello: l'intestazione delle decisioni aperte. */
  const decisionsRef = useRef<HTMLHeadingElement | null>(null);
  const [openSections, setOpenSections] = useState<
    Record<V2ResultSection, boolean>
  >({
    corrected: true,
    review: true,
    rejected: true,
    no_result: true,
    not_procurable: false,
    auto_resolved: false,
  });

  const modeledRows = useMemo(
    () => buildV2ResultRows(rows, { gaps, reviewIssues }),
    [gaps, reviewIssues, rows]
  );
  const filteredRows = useMemo(
    () =>
      filterAndSortV2ResultRows(modeledRows, {
        query,
        section: sectionFilter,
        platform: platformFilter,
        sort,
      }),
    [modeledRows, platformFilter, query, sectionFilter, sort]
  );
  // Tre gruppi, in quest'ordine: quello che è a posto, quello che chiede una
  // decisione, quello che non ha trovato nulla.
  //
  // La sezione decide, non la presenza di un prodotto: una riga i cui
  // candidati sono stati tutti respinti conserva il migliore fra loro come
  // traccia, ma resta un "nessun risultato". Filtrare per `candidate != null`
  // la faceva scivolare fra i confermati.
  const confirmed = filteredRows.filter(
    (row) =>
      row.candidate != null &&
      (row.section === "corrected" || row.section === "auto_resolved")
  );
  const toConfirm = filteredRows.filter((row) => row.section === "review");
  // Le righe non acquistabili hanno anch'esse zero prodotti, ma non sono
  // «scoperte»: hanno una sezione propria e non devono comparire due volte.
  const notProcurable = filteredRows.filter(
    (row) => row.section === "not_procurable"
  );
  // Trovati e respinti: hanno prodotti da guardare, quindi non stanno con le
  // righe vuote. È la distinzione che mancava, e faceva sembrare bugiardo il
  // conteggio di chi apriva «nessun risultato» e ci trovava dentro prodotti.
  const rejected = filteredRows.filter((row) => row.section === "rejected");
  const missing = filteredRows.filter(
    (row) =>
      row.section !== "not_procurable" &&
      row.section !== "rejected" &&
      (row.section === "no_result" || row.candidate == null)
  );
  // «Scoperta» ha due sensi: la ricerca non ha trovato nulla, oppure ha
  // trovato prodotti che il giudice ha respinto tutti. I secondi si mostrano,
  // i primi sono solo un nome e un pulsante per riprovare.
  const missingWithProduct = missing.filter((row) => row.candidate != null);
  const missingEmpty = missing.filter((row) => row.candidate == null);
  const allGrouped = useMemo(() => groupV2ResultRows(modeledRows), [modeledRows]);
  const filteredGrouped = useMemo(
    () => groupV2ResultRows(filteredRows),
    [filteredRows]
  );
  const actions = useMemo(
    () => modeledRows.flatMap((row) => row.actions),
    [modeledRows]
  );
  const selected =
    modeledRows.find((row) => row.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !modeledRows.some((row) => row.id === selectedId)) {
      setSelectedId(null);
    }
  }, [modeledRows, selectedId]);

  /**
   * Il campanello conta e accompagna: non contiene.
   *
   * Prima apriva un pannello con dentro l'elenco delle decisioni, e quel
   * pannello era una seconda copia della sezione «Da confermare» — le stesse
   * righe in due posti, con due modi di aprirle e nessuno dei due completo.
   * Ora porta all'unico posto dove quelle righe vivono: filtra la workspace
   * sulle decisioni aperte e ci scorre sopra.
   */
  function goToOpenDecisions() {
    setQuery("");
    setPlatformFilter("all");
    setSectionFilter("review");
    setOpenSections((current) => ({ ...current, review: true }));
    // Dopo il render del filtro, altrimenti si scorre sulla lista vecchia.
    requestAnimationFrame(() => {
      decisionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function selectSection(value: V2ResultSectionFilter) {
    setSectionFilter(value);
    if (value !== "all") {
      setOpenSections((current) => ({ ...current, [value]: true }));
    }
  }

  // Le righe selezionabili sono quelle senza un prodotto di cui fidarsi:
  // riprovare una riga già confermata sarebbe spendere per rifare ciò che è
  // già riuscito. Le non acquistabili restano fuori: non è la ricerca ad
  // aver fallito.
  const retryable = useMemo(
    () => [...rejected, ...missing].map((row) => row.rowNumber).sort((a, b) => a - b),
    [missing, rejected]
  );
  const chosen = useMemo(
    () => retryable.filter((rowNumber) => chosenRows.has(rowNumber)),
    [retryable, chosenRows]
  );

  useEffect(() => {
    if (!onEstimateRetry || chosen.length === 0) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    void onEstimateRetry(chosen, retryMode)
      .then((fresh) => {
        if (!cancelled) setEstimate(fresh);
      })
      .catch(() => {
        if (!cancelled) setEstimate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [chosen, onEstimateRetry, retryMode]);

  function toggleRow(rowNumber: number) {
    setChosenRows((current) => {
      const next = new Set(current);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  async function launchRetry() {
    if (!onRetryRows || chosen.length === 0) return;
    setRetryBusy(true);
    setRetryError(null);
    setRetryOutcome(null);
    try {
      setRetryOutcome(await onRetryRows(chosen, retryMode));
      setChosenRows(new Set());
    } catch (cause) {
      setRetryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetryBusy(false);
    }
  }

  async function acceptCandidate(rowNumber: number, productId: string) {
    if (!onAcceptCandidate) return;
    setAcceptingRow(rowNumber);
    try {
      await onAcceptCandidate(rowNumber, productId);
    } finally {
      setAcceptingRow(null);
    }
  }

  function clearFilters() {
    setQuery("");
    setSectionFilter("all");
    setPlatformFilter("all");
    setSort("row_asc");
  }

  return (
    <section className={styles.workspace} aria-busy={loading}>
      <div className={styles.toolbar}>
        <label className={styles.searchField}>
          <span className={styles.srOnly}>{copy.search}</span>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            placeholder={copy.search}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <label className={styles.control}>
          <span>{copy.sectionFilter}</span>
          <select
            value={sectionFilter}
            onChange={(event) =>
              selectSection(event.target.value as V2ResultSectionFilter)
            }
          >
            <option value="all">{copy.all}</option>
            {SECTION_ORDER.map((section) => (
              <option key={section} value={section}>
                {copy.sections[section].title}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.control}>
          <span>{copy.platformFilter}</span>
          <select
            value={platformFilter}
            onChange={(event) =>
              setPlatformFilter(event.target.value as V2ResultPlatformFilter)
            }
          >
            <option value="all">{copy.allPlatforms}</option>
            <option value="taobao">Taobao</option>
            <option value="1688">1688</option>
          </select>
        </label>

        <label className={styles.control}>
          <span>{copy.sort}</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as V2ResultSort)}
          >
            <option value="row_asc">{copy.rowAsc}</option>
            <option value="name_asc">{copy.nameAsc}</option>
            <option value="confidence_desc">{copy.confidenceDesc}</option>
            <option value="price_asc">{copy.priceAsc}</option>
          </select>
        </label>

        <span className={styles.visibleCount}>
          {interpolate(copy.visible, {
            shown: filteredRows.length,
            total: modeledRows.length,
          })}
        </span>
        {(query ||
          sectionFilter !== "all" ||
          platformFilter !== "all" ||
          sort !== "row_asc") && (
          <button type="button" className={styles.clearButton} onClick={clearFilters}>
            {copy.clear}
          </button>
        )}

        {/* Un contatore con un collegamento, non un contenitore: porta alla
            sezione dove le decisioni si prendono per davvero. */}
        {actions.length > 0 ? (
          <button
            type="button"
            className={styles.bell}
            aria-controls="v2-open-decisions"
            aria-label={interpolate(copy.bell, { count: actions.length })}
            title={interpolate(copy.bell, { count: actions.length })}
            onClick={goToOpenDecisions}
          >
            <span aria-hidden="true">🔔</span>
            <span className={styles.bellCount}>{actions.length}</span>
          </button>
        ) : null}
      </div>

      {loading ? <p className={styles.stateMessage}>{copy.loading}</p> : null}
      {loadError ? (
        <p className={styles.errorMessage} role="alert">
          {loadError}
        </p>
      ) : null}

      {!loading && modeledRows.length === 0 ? (
        <p className={styles.stateMessage}>{copy.noStoredRows}</p>
      ) : filteredRows.length === 0 && modeledRows.length > 0 ? (
        <p className={styles.stateMessage}>{copy.empty}</p>
      ) : null}

      {/* Il report: una riga per prodotto trovato, e nient'altro.
          Foto, titolo, quanto ordinare, quanto costa, quanto si rivende. */}
      {confirmed.length > 0 ? (
        <>
          <h4 className={styles.groupHeading}>
            {copy.confirmedTitle}
            <span className={styles.groupCount}>{confirmed.length}</span>
          </h4>
          <div className={styles.report} role="list">
            {confirmed.map((row) => (
              <ReportRow
                key={row.id}
                row={row}
                markupPct={markupPct}
                intlLocale={intlLocale}
                copy={copy}
                onOpen={() => setSelectedId(row.id)}
              />
            ))}
          </div>
        </>
      ) : null}

      {/* Solo ciò che l'IA non può chiudere da sola: una scelta di variante o
          una decisione commerciale. Se questo blocco è lungo, è un difetto. */}
      {toConfirm.length > 0 ? (
        <>
          <h4
            className={styles.groupHeading}
            id="v2-open-decisions"
            ref={decisionsRef}
            tabIndex={-1}
          >
            {copy.toConfirmTitle}
            <span className={`${styles.groupCount} ${styles.groupCountWarn}`}>
              {toConfirm.length}
            </span>
          </h4>
          <div className={styles.report} role="list">
            {toConfirm.map((row) => (
              <ReportRow
                key={row.id}
                row={row}
                markupPct={markupPct}
                intlLocale={intlLocale}
                copy={copy}
                onOpen={() => setSelectedId(row.id)}
                needsDecision
              />
            ))}
          </div>
        </>
      ) : null}

      {/* Trovati e respinti: prodotti veri, con scritto perché sono stati
          scartati e un pulsante per ribaltare il giudizio. Aperta di default,
          perché è la sezione dove c'è qualcosa da fare. */}
      {rejected.length > 0 ? (
        <details className={styles.missingBlock} open>
          <summary>
            {copy.sections.rejected.title}
            <span className={styles.missingCount}>{rejected.length}</span>
          </summary>
          <p className={styles.stateMessage}>{copy.sections.rejected.hint}</p>
          {onRetryRows ? (
            <RetryBar
              copy={copy}
              chosen={chosen}
              retryable={retryable}
              mode={retryMode}
              estimate={estimate}
              busy={retryBusy}
              result={retryOutcome}
              error={retryError}
              onMode={setRetryMode}
              onSelectAll={() => setChosenRows(new Set(retryable))}
              onClear={() => setChosenRows(new Set())}
              onLaunch={launchRetry}
            />
          ) : null}
          <div className={styles.report} role="list">
            {rejected.map((row) => (
              <div key={row.id} className={styles.rejectedRow}>
                <div className={styles.selectableRow}>
                  {onRetryRows ? (
                    <input
                      type="checkbox"
                      aria-label={interpolate(copy.selectRow, {
                        row: row.rowNumber,
                      })}
                      checked={chosenRows.has(row.rowNumber)}
                      onChange={() => toggleRow(row.rowNumber)}
                    />
                  ) : null}
                  <ReportRow
                    row={row}
                    markupPct={markupPct}
                    intlLocale={intlLocale}
                    copy={copy}
                    onOpen={() => setSelectedId(row.id)}
                    needsDecision
                  />
                </div>
                <div className={styles.rejectedWhy}>
                  <span>
                    <strong>{copy.rejectedWhy}:</strong>{" "}
                    {row.gap?.detail || row.candidate?.coherence?.issues?.join(" · ") || "—"}
                  </span>
                  {onAcceptCandidate && row.candidate ? (
                    <button
                      type="button"
                      className={styles.acceptButton}
                      disabled={acceptingRow === row.rowNumber}
                      onClick={() =>
                        acceptCandidate(
                          row.rowNumber,
                          row.candidate!.product.productId
                        )
                      }
                    >
                      {acceptingRow === row.rowNumber
                        ? copy.accepting
                        : copy.acceptTitle}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {/* Le righe scoperte stanno in fondo, senza rubare spazio al report. */}
      {missing.length > 0 ? (
        <details className={styles.missingBlock}>
          <summary>
            {copy.sections.no_result.title}
            <span className={styles.missingCount}>{missing.length}</span>
          </summary>
          {/* Le righe dove un prodotto è stato trovato ma respinto restano
              guardabili: è l'unico modo per ribaltare un rifiuto sbagliato,
              e nasconderle faceva sembrare vuota una riga che non lo era. */}
          {onRetryRows ? (
            <RetryBar
              copy={copy}
              chosen={chosen}
              retryable={retryable}
              mode={retryMode}
              estimate={estimate}
              busy={retryBusy}
              result={retryOutcome}
              error={retryError}
              onMode={setRetryMode}
              onSelectAll={() => setChosenRows(new Set(retryable))}
              onClear={() => setChosenRows(new Set())}
              onLaunch={launchRetry}
            />
          ) : null}
          {missingWithProduct.length > 0 ? (
            <div className={styles.report} role="list">
              {missingWithProduct.map((row) => (
                <div key={row.id} className={styles.selectableRow}>
                  {onRetryRows ? (
                    <input
                      type="checkbox"
                      aria-label={interpolate(copy.selectRow, {
                        row: row.rowNumber,
                      })}
                      checked={chosenRows.has(row.rowNumber)}
                      onChange={() => toggleRow(row.rowNumber)}
                    />
                  ) : null}
                  <ReportRow
                    row={row}
                    markupPct={markupPct}
                    intlLocale={intlLocale}
                    copy={copy}
                    onOpen={() => setSelectedId(row.id)}
                    needsDecision
                  />
                </div>
              ))}
            </div>
          ) : null}
          <ul className={styles.missingList}>
            {missingEmpty.map((row) => (
              <li key={row.id}>
                {onRetryRows ? (
                  <input
                    type="checkbox"
                    aria-label={interpolate(copy.selectRow, {
                      row: row.rowNumber,
                    })}
                    checked={chosenRows.has(row.rowNumber)}
                    onChange={() => toggleRow(row.rowNumber)}
                  />
                ) : null}
                <span className={styles.rowNumber}>#{row.rowNumber}</span>
                <span className={styles.missingName}>{row.displayName}</span>
                {row.gap?.detail ? (
                  <span className={styles.missingReason}>{row.gap.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Non è un fallimento della ricerca: è una richiesta che il
          marketplace non può evadere. Sta sotto le righe scoperte, chiusa,
          con il motivo accanto a ogni riga — e senza pulsante «riprova»,
          perché non c'è niente da riprovare. */}
      {notProcurable.length > 0 ? (
        <details className={styles.missingBlock}>
          <summary>
            {copy.sections.not_procurable.title}
            <span className={styles.missingCount}>{notProcurable.length}</span>
          </summary>
          <p className={styles.stateMessage}>
            {copy.sections.not_procurable.hint}
          </p>
          <ul className={styles.missingList}>
            {notProcurable.map((row) => (
              <li key={row.id}>
                <span className={styles.rowNumber}>#{row.rowNumber}</span>
                <span className={styles.missingName}>{row.displayName}</span>
                {row.gap?.detail ? <span>{row.gap.detail}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {selected ? (
        <ProductDialog
          row={selected}
          markupPct={markupPct}
          intlLocale={intlLocale}
          copy={copy}
          columns={columns}
          onClose={() => setSelectedId(null)}
          onAccept={
            onAcceptCandidate
              ? (productId: string) =>
                  onAcceptCandidate(selected.rowNumber, productId)
              : undefined
          }
        />
      ) : null}
    </section>
  );
}

/** Prezzo con la maggiorazione applicata: è quello che si rivende. */
function markedUpPrice(price: number | null, markupPct: number): number | null {
  if (price == null) return null;
  return price * (1 + markupPct / 100);
}

/**
 * Una riga del report.
 *
 * Mostra solo ciò che serve per ordinare e per quotare. Tutto il resto —
 * specifiche, negozio, verdetti, alternative — sta nella scheda, che si apre
 * al clic e si chiude subito.
 */
function ReportRow({
  row,
  markupPct,
  intlLocale,
  copy,
  onOpen,
  needsDecision = false,
}: {
  row: V2ResultRow;
  markupPct: number;
  intlLocale: string;
  copy: (typeof COPY)[keyof typeof COPY];
  onOpen: () => void;
  needsDecision?: boolean;
}) {
  const candidate = row.candidate;
  const title = candidate?.product.title ?? row.displayName;

  return (
    <article
      className={`${styles.reportRow} ${needsDecision ? styles.reportRowWarn : ""}`}
      role="listitem"
    >
      <Thumbnail src={row.imageUrl} alt={title} fallback={copy.imageMissing} />

      <div className={styles.reportMain}>
        <p className={styles.reportTitle} title={title}>
          {title}
        </p>
        {/* Quello che il cliente ha chiesto viene prima: è il testo del
            foglio. Il nome estratto dall'analisi compare **solo** quando
            aggiunge qualcosa — spesso è già contenuto lì dentro (品名 静电棒
            dentro «静电棒 · 橙色») e ripeterlo è rumore fra il titolo del
            prodotto trovato e ciò con cui va confrontato. */}
        <p className={styles.reportRequested}>
          <span className={styles.rowNumber}>#{row.rowNumber}</span>
          {row.originalTitle ?? row.displayName}
        </p>
        {row.originalTitle && !row.originalTitle.includes(row.displayName) ? (
          <p className={styles.reportOriginal} title={row.displayName}>
            {copy.searchedAs} {row.displayName}
          </p>
        ) : null}
        {/* Quale decisione serve, scritto sulla riga. Prima viveva dentro il
            pannello del campanello: si sapeva che c'era una decisione da
            prendere, ma non su quale riga finché non la si apriva. */}
        {row.actions.length > 0 ? (
          <p className={styles.reportDecisions}>
            {row.actions.map((action) => (
              <span key={action.id} className={styles.actionType}>
                {copy.actionTypes[action.type]}
              </span>
            ))}
          </p>
        ) : null}
      </div>

      <div className={styles.reportFigure}>
        <span className={styles.figureLabel}>{copy.qtyLabel}</span>
        <strong className={styles.figureQty}>
          {row.requestedQuantity ?? "—"}
          {row.requestedUnit ? <em>{row.requestedUnit}</em> : null}
        </strong>
      </div>

      <div className={styles.reportFigure}>
        <span className={styles.figureLabel}>{copy.costLabel}</span>
        <strong className={styles.figureCost}>
          {formatPrice(row.price, row.currency, intlLocale)}
        </strong>
      </div>

      <div className={styles.reportFigure}>
        <span className={styles.figureLabel}>{copy.sellLabel}</span>
        <strong className={styles.figureSell}>
          {formatPrice(
            markedUpPrice(row.price, markupPct),
            row.currency,
            intlLocale
          )}
        </strong>
      </div>

      <div className={styles.reportActions}>
        {candidate?.product.url ? (
          <a
            className={styles.taobaoLink}
            href={candidate.product.url}
            target="_blank"
            rel="noreferrer"
          >
            {marketplaceLabel(candidate.product.url, candidate.product.platform)}
          </a>
        ) : null}
        <button type="button" className={styles.detailButton} onClick={onOpen}>
          {copy.showDetail}
        </button>
      </div>
    </article>
  );
}

/**
 * La barra della riprova: cosa si rifà, come, e quanto costa.
 *
 * I due gradini stanno nello stesso posto e nello stesso ordine in cui vanno
 * provati — prima rileggere ciò che è già stato pagato, poi tornare a cercare
 * — e la stima è accanto al pulsante, non dopo il clic. È l'unica differenza
 * che conta fra i due: uno non spende chiamate, l'altro sì.
 */
function RetryBar({
  copy,
  chosen,
  retryable,
  mode,
  estimate,
  busy,
  result,
  error,
  onMode,
  onSelectAll,
  onClear,
  onLaunch,
}: {
  copy: (typeof COPY)[keyof typeof COPY];
  chosen: readonly number[];
  retryable: readonly number[];
  mode: V2RetryMode;
  estimate: V2RetryEstimate | null;
  busy: boolean;
  result: V2RetryResult | null;
  error: string | null;
  onMode: (mode: V2RetryMode) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onLaunch: () => void;
}) {
  return (
    <div className={styles.retryBar}>
      <div className={styles.retryChoice}>
        <strong>
          {interpolate(copy.retrySelected, {
            chosen: chosen.length,
            total: retryable.length,
          })}
        </strong>
        <button type="button" className={styles.chipButton} onClick={onSelectAll}>
          {copy.retrySelectAll}
        </button>
        <button
          type="button"
          className={styles.chipButton}
          onClick={onClear}
          disabled={chosen.length === 0}
        >
          {copy.retryClear}
        </button>
      </div>

      <div className={styles.retryModes} role="radiogroup" aria-label={copy.retryModeLabel}>
        {(["rejudge", "research"] as const).map((value) => (
          <label key={value} className={styles.retryMode}>
            <input
              type="radio"
              name="v2-retry-mode"
              value={value}
              checked={mode === value}
              onChange={() => onMode(value)}
            />
            <span>
              <strong>{copy.retryModes[value].title}</strong>
              <em>{copy.retryModes[value].hint}</em>
            </span>
          </label>
        ))}
      </div>

      <div className={styles.retryLaunch}>
        <span className={styles.retryEstimate}>
          {chosen.length === 0
            ? copy.retryPickFirst
            : estimate
              ? interpolate(copy.retryCost, {
                  rows: estimate.rows,
                  calls: estimate.searchCalls,
                  cost: estimate.estimatedCostUsd.toFixed(4),
                })
              : copy.retryEstimating}
        </span>
        <button
          type="button"
          className={styles.retryButton}
          disabled={busy || chosen.length === 0}
          onClick={onLaunch}
        >
          {busy ? copy.retrying : copy.retryLaunch}
        </button>
      </div>

      {result ? (
        <p className={styles.retryResult}>
          {interpolate(copy.retryDone, {
            recovered: result.recoveredRows,
            rows: result.rows,
            spent: result.spentUsd.toFixed(4),
          })}
        </p>
      ) : null}
      {error ? (
        <p className={styles.errorMessage} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * La scheda del prodotto, in un popup.
 *
 * Si apre dal report e si chiude subito: serve a guardare il prodotto da
 * vicino — foto grande, cosa era stato chiesto, cosa costa — non a gestire un
 * flusso di lavoro. Tutto ciò che non aiuta quella occhiata sta fuori.
 */
function ProductDialog({
  row,
  markupPct,
  intlLocale,
  copy,
  columns,
  onClose,
  onAccept,
}: {
  row: V2ResultRow;
  markupPct: number;
  intlLocale: string;
  /** Intestazioni del foglio, per dare un nome alle celle originali. */
  columns: readonly string[];
  copy: (typeof COPY)[keyof typeof COPY];
  onClose: () => void;
  /** Sceglie un'altra proposta per questa riga; assente sui risultati storici. */
  onAccept?: (productId: string) => Promise<void>;
}) {
  const candidate = row.candidate;
  const [switching, setSwitching] = useState<string | null>(null);
  // La riga del foglio così com'era: solo le celle piene, con la loro
  // intestazione. È la prova di che cosa il cliente aveva davvero chiesto.
  const originalRow = (row.source?.originalCells ?? [])
    .map((value, position) => [columns[position] ?? `#${position + 1}`, value.trim()] as const)
    .filter(([, value]) => value.length > 0);
  const title = candidate?.product.title ?? row.displayName;

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={styles.dialogBackdrop}
      role="presentation"
      onClick={onClose}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className={styles.dialogClose}
          aria-label={copy.closeDetails}
          onClick={onClose}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <Thumbnail src={row.imageUrl} alt={title} fallback={copy.imageMissing} large />

        <div className={styles.dialogBody}>
          <p className={styles.dialogTitle}>{title}</p>
          <p className={styles.dialogRequested}>
            <span className={styles.rowNumber}>#{row.rowNumber}</span>
            {row.originalTitle ?? row.displayName}
          </p>
          {row.originalTitle && !row.originalTitle.includes(row.displayName) ? (
            <p className={styles.reportOriginal}>
              {copy.searchedAs} {row.displayName}
            </p>
          ) : null}

          <div className={styles.dialogFigures}>
            <div>
              <span className={styles.figureLabel}>{copy.qtyLabel}</span>
              <strong className={styles.figureQty}>
                {row.requestedQuantity ?? "—"}
                {row.requestedUnit ? <em>{row.requestedUnit}</em> : null}
              </strong>
            </div>
            <div>
              <span className={styles.figureLabel}>{copy.costLabel}</span>
              <strong className={styles.figureCost}>
                {formatPrice(row.price, row.currency, intlLocale)}
              </strong>
              {/* Il listino accanto allo scontato: senza, la cifra sembra
                  semplicemente sbagliata rispetto alla pagina Taobao. */}
              {row.promoPrice != null ? (
                <span className={styles.figureList}>
                  {row.promoIsList ? copy.listPriceLabel : copy.listLabel}{" "}
                  {formatPrice(row.promoPrice, row.currency, intlLocale)}
                </span>
              ) : null}
            </div>
            <div>
              <span className={styles.figureLabel}>{copy.sellLabel}</span>
              <strong className={styles.figureSell}>
                {formatPrice(
                  markedUpPrice(row.price, markupPct),
                  row.currency,
                  intlLocale
                )}
              </strong>
            </div>
          </div>

          {candidate?.product.lastCheckedAt ? (
            <p className={styles.dialogNote}>
              {copy.priceNote}
              {" · "}
              {copy.readAt}{" "}
              {new Date(candidate.product.lastCheckedAt).toLocaleString(
                intlLocale
              )}
            </p>
          ) : null}

          {candidate?.product.url ? (
            <a
              className={styles.dialogLink}
              href={candidate.product.url}
              target="_blank"
              rel="noreferrer"
            >
              {copy.openProduct}
            </a>
          ) : null}

          {/* Le altre proposte, con il loro prezzo.
              La ricerca le ha già pagate tutte e finora restavano invisibili:
              chi guardava vedeva un prezzo e doveva fidarsi che fosse il
              migliore. Non lo è per forza — la scelta la fa la compatibilità,
              non il prezzo — e un prezzo più basso è spesso una confezione
              più piccola, quindi le si mostrano insieme e decide una persona. */}
          {originalRow.length > 0 ? (
            <div className={styles.originalRow}>
              <h4>{copy.original}</h4>
              <dl>
                {originalRow.map(([header, value]) => (
                  <div key={`${header}-${value}`}>
                    <dt>{header}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {row.candidates.length > 1 ? (
            <div className={styles.alternatives}>
              <h4>{copy.alternatives}</h4>
              <p className={styles.dialogNote}>{copy.alternativesHint}</p>
              <ul>
                {row.candidates.map((entry) => {
                  // Stessa regola della scheda: si mostra il listino della
                  // variante predefinita, non la «promozione» della fonte.
                  const price =
                    entry.product.price ?? entry.product.promotionPrice ?? null;
                  const current =
                    entry.product.productId === candidate?.product.productId;
                  return (
                    <li key={entry.product.productId}>
                      <span className={styles.altPrice}>
                        {formatPrice(price, entry.product.currency, intlLocale)}
                      </span>
                      <a
                        className={styles.altTitle}
                        href={entry.product.url ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        title={entry.product.title}
                      >
                        {entry.product.title}
                      </a>
                      <span className={styles.altShop}>
                        {marketplaceLabel(entry.product.url, entry.product.platform)}
                        {entry.product.shopName ? ` · ${entry.product.shopName}` : ""}
                      </span>
                      {current ? (
                        <span className={styles.altCurrent}>{copy.inUse}</span>
                      ) : onAccept ? (
                        <button
                          type="button"
                          className={styles.acceptButton}
                          disabled={switching != null}
                          onClick={async () => {
                            setSwitching(entry.product.productId);
                            try {
                              await onAccept(entry.product.productId);
                              onClose();
                            } finally {
                              setSwitching(null);
                            }
                          }}
                        >
                          {switching === entry.product.productId
                            ? copy.accepting
                            : copy.useThis}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DetailList({
  title,
  items,
  tone,
}: {
  title: string;
  items: readonly string[];
  tone?: "attention";
}) {
  return (
    <section
      className={`${styles.detailList}${tone ? ` ${styles.attention}` : ""}`}
    >
      <h4>{title}</h4>
      <ul>
        {items.map((item, index) => (
          <li key={`${item}:${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function Thumbnail({
  src,
  alt,
  fallback,
  large = false,
}: {
  src: string | null;
  alt: string;
  fallback: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return (
      <span
        className={`${styles.thumbnail} ${large ? styles.thumbnailLarge : ""} ${
          styles.thumbnailFallback
        }`}
        role="img"
        aria-label={fallback}
        title={fallback}
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L20 20" />
        </svg>
      </span>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      className={`${styles.thumbnail} ${large ? styles.thumbnailLarge : ""}`}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function formatPrice(
  value: number | null,
  currency: string | null,
  intlLocale: string
): string {
  if (value == null) return "—";
  try {
    return new Intl.NumberFormat(
      intlLocale,
      currency
        ? { style: "currency", currency, maximumFractionDigits: 2 }
        : { maximumFractionDigits: 2 }
    ).format(value);
  } catch {
    return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

function interpolate(
  template: string,
  values: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(values[key] ?? "")
  );
}

export type { V2HumanActionType };
