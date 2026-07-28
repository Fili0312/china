"use client";

import {
  TAOBAO_ROW_STATUS_LABELS,
  type TaobaoPipelineGap,
  type TaobaoPipelineReviewIssue,
  type TaobaoRowResults,
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
  type V2HumanAction,
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
      no_result: {
        title: "Nessun risultato",
        hint: "Righe senza un prodotto utilizzabile.",
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
    listLabel: "listino",
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
    triedQueries: "Query provate",
    unavailable: "Non disponibile",
    reused: "Riusato",
    candidates: "{count} candidati",
    rowStatus: "Stato job: {status}",
    details: "Dettagli riga #{row}",
    closeDetails: "Chiudi dettagli",
    query: "Query",
    original: "Valori originali",
    error: "Errore",
    technicalChecks: "Controlli tecnici",
    automaticChecks: "Controlli risolti automaticamente",
    alternatives: "Alternative salvate",
    openProduct: "Apri il prodotto",
    actionsTitle: "Interventi richiesti",
    actionsHint: "Solo decisioni che il sistema non può prendere in autonomia.",
    closeActions: "Chiudi interventi",
    bell: "{count} interventi umani richiesti",
    actionFor: "Riga #{row} · {name}",
    actionTypes: {
      APPROVE_EQUIVALENT: "Approva equivalente",
      CHOOSE_VARIANT: "Scegli variante",
      CLARIFY_REQUIREMENT: "Chiarisci requisito",
      CHANGE_TOLERANCE: "Modifica tolleranza",
      MARK_UNAVAILABLE: "Segna non disponibile",
    },
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
      no_result: {
        title: "No result",
        hint: "Rows without a usable product.",
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
    listLabel: "list",
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
    triedQueries: "Queries tried",
    unavailable: "Unavailable",
    reused: "Reused",
    candidates: "{count} candidates",
    rowStatus: "Job status: {status}",
    details: "Row #{row} details",
    closeDetails: "Close details",
    query: "Query",
    original: "Original values",
    error: "Error",
    technicalChecks: "Technical checks",
    automaticChecks: "Automatically resolved checks",
    alternatives: "Saved alternatives",
    openProduct: "Open product",
    actionsTitle: "Required interventions",
    actionsHint: "Only decisions the system cannot safely make on its own.",
    closeActions: "Close interventions",
    bell: "{count} human interventions required",
    actionFor: "Row #{row} · {name}",
    actionTypes: {
      APPROVE_EQUIVALENT: "Approve equivalent",
      CHOOSE_VARIANT: "Choose variant",
      CLARIFY_REQUIREMENT: "Clarify requirement",
      CHANGE_TOLERANCE: "Change tolerance",
      MARK_UNAVAILABLE: "Mark unavailable",
    },
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
      no_result: {
        title: "无结果",
        hint: "没有可用产品的行。",
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
    listLabel: "原价",
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
    triedQueries: "已尝试的搜索词",
    unavailable: "不可用",
    reused: "已复用",
    candidates: "{count} 个候选项",
    rowStatus: "任务状态：{status}",
    details: "第 {row} 行详情",
    closeDetails: "关闭详情",
    query: "搜索词",
    original: "原始值",
    error: "错误",
    technicalChecks: "技术检查",
    automaticChecks: "自动解决的检查",
    alternatives: "已保存的备选项",
    openProduct: "打开产品",
    actionsTitle: "需要处理",
    actionsHint: "仅显示系统无法安全自动决定的事项。",
    closeActions: "关闭处理面板",
    bell: "需要 {count} 项人工处理",
    actionFor: "第 {row} 行 · {name}",
    actionTypes: {
      APPROVE_EQUIVALENT: "批准等效产品",
      CHOOSE_VARIANT: "选择规格",
      CLARIFY_REQUIREMENT: "澄清需求",
      CHANGE_TOLERANCE: "调整容差",
      MARK_UNAVAILABLE: "标记为不可用",
    },
  },
} as const;

interface ResultsWorkspaceProps {
  rows: readonly TaobaoRowResults[];
  gaps?: readonly TaobaoPipelineGap[];
  reviewIssues?: readonly TaobaoPipelineReviewIssue[];
  loading?: boolean;
  loadError?: string | null;
  /** Maggiorazione da applicare al costo per ottenere il prezzo di vendita. */
  markupPct?: number;
  /**
   * Ripete la ricerca di una sola riga.
   *
   * Assente quando i risultati sono storici: lì non c'è un job vivo da
   * rilanciare, e un pulsante che non fa nulla è peggio di nessun pulsante.
   */
  onRetryRow?: (rowNumber: number) => Promise<void> | void;
}

export function ResultsWorkspace({
  rows,
  gaps = [],
  reviewIssues = [],
  loading = false,
  loadError = null,
  markupPct = 0,
  onRetryRow,
}: ResultsWorkspaceProps) {
  const { locale, intlLocale } = useI18n();
  const copy = COPY[locale];
  const [query, setQuery] = useState("");
  const [sectionFilter, setSectionFilter] =
    useState<V2ResultSectionFilter>("all");
  const [platformFilter, setPlatformFilter] =
    useState<V2ResultPlatformFilter>("all");
  const [sort, setSort] = useState<V2ResultSort>("row_asc");
  const [retryingRow, setRetryingRow] = useState<number | null>(null);


  const retryRow = onRetryRow
    ? async (rowNumber: number) => {
        setRetryingRow(rowNumber);
        try {
          await onRetryRow(rowNumber);
        } finally {
          setRetryingRow(null);
        }
      }
    : undefined;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [openSections, setOpenSections] = useState<
    Record<V2ResultSection, boolean>
  >({
    corrected: true,
    review: true,
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
  const missing = filteredRows.filter(
    (row) =>
      row.section !== "not_procurable" &&
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

  function showAction(action: V2HumanAction) {
    const row = modeledRows.find((entry) => entry.id === action.rowId);
    setQuery("");
    setPlatformFilter("all");
    setSectionFilter("all");
    setSelectedId(action.rowId);
    setActionsOpen(false);
    if (row) {
      setOpenSections((current) => ({ ...current, [row.section]: true }));
    }
  }

  function selectSection(value: V2ResultSectionFilter) {
    setSectionFilter(value);
    if (value !== "all") {
      setOpenSections((current) => ({ ...current, [value]: true }));
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

        {actions.length > 0 ? (
          <button
            type="button"
            className={styles.bell}
            aria-expanded={actionsOpen}
            aria-controls="v2-human-actions"
            aria-label={interpolate(copy.bell, { count: actions.length })}
            onClick={() => setActionsOpen((current) => !current)}
          >
            <span aria-hidden="true">🔔</span>
            <span className={styles.bellCount}>{actions.length}</span>
          </button>
        ) : null}
      </div>

      {actionsOpen && actions.length > 0 ? (
        <aside id="v2-human-actions" className={styles.actionsPanel}>
          <div className={styles.panelHeading}>
            <div>
              <h3>{copy.actionsTitle}</h3>
              <p>{copy.actionsHint}</p>
            </div>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={copy.closeActions}
              onClick={() => setActionsOpen(false)}
            >
              ×
            </button>
          </div>
          <ol className={styles.actionList}>
            {actions.map((action) => (
              <li key={action.id}>
                <button type="button" onClick={() => showAction(action)}>
                  <span className={styles.actionType}>
                    {copy.actionTypes[action.type]}
                  </span>
                  <strong>
                    {interpolate(copy.actionFor, {
                      row: action.rowNumber,
                      name: action.displayName,
                    })}
                  </strong>
                  {action.detail ? <span>{action.detail}</span> : null}
                </button>
              </li>
            ))}
          </ol>
        </aside>
      ) : null}

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
          <h4 className={styles.groupHeading}>
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
          {missingWithProduct.length > 0 ? (
            <div className={styles.report} role="list">
              {missingWithProduct.map((row) => (
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
          ) : null}
          <ul className={styles.missingList}>
            {missingEmpty.map((row) => (
              <li key={row.id}>
                <span className={styles.rowNumber}>#{row.rowNumber}</span>
                <span className={styles.missingName}>{row.displayName}</span>
                {retryRow ? (
                  <button
                    type="button"
                    className={styles.retryButton}
                    disabled={retryingRow === row.rowNumber}
                    onClick={() => retryRow(row.rowNumber)}
                  >
                    {retryingRow === row.rowNumber
                      ? copy.retrying
                      : copy.retryRow}
                  </button>
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
          onClose={() => setSelectedId(null)}
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
        <p className={styles.reportRequested}>
          <span className={styles.rowNumber}>#{row.rowNumber}</span>
          {row.displayName}
        </p>
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
            Taobao
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
  onClose,
}: {
  row: V2ResultRow;
  markupPct: number;
  intlLocale: string;
  copy: (typeof COPY)[keyof typeof COPY];
  onClose: () => void;
}) {
  const candidate = row.candidate;
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
            {row.displayName}
          </p>

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
              {row.listPrice != null && row.listPrice !== row.price ? (
                <span className={styles.figureList}>
                  {copy.listLabel}{" "}
                  {formatPrice(row.listPrice, row.currency, intlLocale)}
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
