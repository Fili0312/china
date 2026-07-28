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
const LINE_HEIGHT = 52;
const SECTION_ORDER: readonly V2ResultSection[] = [
  "corrected",
  "review",
  "no_result",
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
      auto_resolved: {
        title: "Controlli auto-risolti",
        hint: "Verifiche gestite automaticamente; sezione chiusa di default.",
      },
    },
    candidateMissing: "Nessun prodotto",
    imageMissing: "Immagine non disponibile",
    unitMissing: "unità non indicata",
    notVerified: "Non verificato",
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
      auto_resolved: {
        title: "Automatically resolved checks",
        hint: "Checks handled automatically; collapsed by default.",
      },
    },
    candidateMissing: "No product",
    imageMissing: "Image unavailable",
    unitMissing: "unit not specified",
    notVerified: "Not verified",
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
      auto_resolved: {
        title: "自动解决的检查",
        hint: "系统已自动处理；默认折叠。",
      },
    },
    candidateMissing: "没有产品",
    imageMissing: "图片不可用",
    unitMissing: "未注明销售单位",
    notVerified: "未验证",
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

      <div className={styles.sections}>
        {SECTION_ORDER.filter(
          (section) => sectionFilter === "all" || sectionFilter === section
        ).map((section) => {
          const visibleRows = filteredGrouped[section];
          const total = allGrouped[section].length;
          const isOpen = openSections[section];
          return (
            <section
              key={section}
              className={`${styles.resultSection} ${styles[section]}`}
            >
              <button
                type="button"
                className={styles.sectionHeading}
                aria-expanded={isOpen}
                onClick={() =>
                  setOpenSections((current) => ({
                    ...current,
                    [section]: !current[section],
                  }))
                }
              >
                <span className={styles.chevron} aria-hidden="true">
                  {isOpen ? "▾" : "▸"}
                </span>
                <span>
                  <strong>{copy.sections[section].title}</strong>
                  <small>{copy.sections[section].hint}</small>
                </span>
                <span className={styles.sectionCount}>
                  {visibleRows.length === total
                    ? total
                    : `${visibleRows.length}/${total}`}
                </span>
              </button>

              {isOpen ? (
                visibleRows.length > 0 ? (
                  <VirtualizedRows
                    rows={visibleRows}
                    selectedId={selectedId}
                    locale={locale}
                    intlLocale={intlLocale}
                    copy={copy}
                    onSelect={setSelectedId}
                    onRetryRow={retryRow}
                    retryingRow={retryingRow}
                  />
                ) : (
                  <p className={styles.sectionEmpty}>{copy.empty}</p>
                )
              ) : null}
            </section>
          );
        })}
      </div>

      {selected ? (
        <ResultDetails
          row={selected}
          intlLocale={intlLocale}
          copy={copy}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * La lista dei risultati: una riga per richiesta, sette informazioni.
 *
 * È la vista per scorrere centinaia di righe, non per approvarle una a una:
 * mostra solo ciò che serve a decidere se aprire il dettaglio — immagine,
 * cosa era stato chiesto, cosa è stato trovato, prezzo, variante, stato e il
 * link alla scheda originale. Tutto il resto vive nel pannello di dettaglio.
 *
 * Si virtualizza per riga: con mille prodotti restano montati solo quelli
 * visibili, e le immagini si caricano solo quando entrano nello schermo.
 */
function VirtualizedRows({
  rows,
  selectedId,
  locale,
  intlLocale,
  copy,
  onSelect,
  onRetryRow,
  retryingRow,
}: {
  rows: readonly V2ResultRow[];
  selectedId: string | null;
  locale: keyof typeof COPY;
  intlLocale: string;
  copy: (typeof COPY)[keyof typeof COPY];
  onSelect: (id: string) => void;
  onRetryRow?: (rowNumber: number) => void;
  retryingRow?: number | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(430);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setViewportHeight(viewport.clientHeight || 430);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setScrollTop(0);
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [rows]);

  const window = calculateVirtualWindow(
    rows.length,
    scrollTop,
    viewportHeight,
    LINE_HEIGHT
  );
  const visible = rows.slice(window.start, window.end);

  return (
    <div
      ref={viewportRef}
      className={styles.gridViewport}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      tabIndex={0}
    >
      {window.paddingTop > 0 ? (
        <div aria-hidden="true" style={{ height: window.paddingTop }} />
      ) : null}
      <div className={styles.lineList} role="list">
        {visible.map((row) => (
          <ResultLine
            key={row.id}
            row={row}
            selected={selectedId === row.id}
            locale={locale}
            intlLocale={intlLocale}
            copy={copy}
            onSelect={onSelect}
            onRetryRow={onRetryRow}
            retrying={retryingRow === row.rowNumber}
          />
        ))}
      </div>
      {window.paddingBottom > 0 ? (
        <div aria-hidden="true" style={{ height: window.paddingBottom }} />
      ) : null}
    </div>
  );
}

function ResultLine({
  row,
  selected,
  locale,
  intlLocale,
  copy,
  onSelect,
  onRetryRow,
  retrying,
}: {
  row: V2ResultRow;
  selected: boolean;
  locale: keyof typeof COPY;
  intlLocale: string;
  copy: (typeof COPY)[keyof typeof COPY];
  onSelect: (id: string) => void;
  onRetryRow?: (rowNumber: number) => void;
  retrying?: boolean;
}) {
  const candidate = row.candidate;
  const status =
    row.status === "UNKNOWN"
      ? copy.notVerified
      : TAOBAO_ROW_STATUS_LABELS[locale][row.status];
  const variant = row.sku ?? copy.unitMissing;

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(row.id);
    }
  }

  return (
    <article
      className={`${styles.line} ${selected ? styles.lineSelected : ""}`}
      role="listitem"
      tabIndex={0}
      aria-selected={selected}
      aria-label={candidate?.product.title ?? row.displayName}
      onClick={() => onSelect(row.id)}
      onKeyDown={onKeyDown}
    >
      <span className={styles.lineThumb}>
        <Thumbnail
          src={row.imageUrl}
          alt={candidate?.product.title ?? row.displayName}
          fallback={copy.imageMissing}
        />
      </span>

      <span className={styles.lineRequested} title={row.displayName}>
        <span className={styles.rowNumber}>#{row.rowNumber}</span>
        {row.displayName}
      </span>

      <span className={styles.lineFound}>
        {candidate ? (
          <span title={candidate.product.title}>{candidate.product.title}</span>
        ) : (
          // Senza prodotto la riga deve dire perché, non restare muta.
          <span className={styles.lineMissing}>
            {row.gap?.detail ?? copy.candidateMissing}
          </span>
        )}
      </span>

      {/* Quanto ordinare: viene dal foglio, ed è il dato con cui si compila
          l'ordine. Senza questo il prezzo unitario non basta. */}
      <span className={styles.lineQty}>
        {row.requestedQuantity != null
          ? `${row.requestedQuantity}${row.requestedUnit ? ` ${row.requestedUnit}` : ""}`
          : "—"}
      </span>

      <span className={styles.linePrice}>
        {formatPrice(row.price, row.currency, intlLocale)}
      </span>

      <span className={styles.lineVariant} title={variant}>
        {variant}
      </span>

      <span className={`${styles.lineStatus} ${styles[row.section]}`}>
        {status}
        {row.actions.length > 0 ? (
          <span className={styles.lineAlert} title={copy.sections.review.title}>
            !
          </span>
        ) : null}
      </span>

      <span className={styles.lineActions}>
        {candidate?.product.url ? (
          <a
            className={styles.cardLink}
            href={candidate.product.url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {copy.openProduct}
          </a>
        ) : onRetryRow ? (
          <button
            type="button"
            className={styles.retryButton}
            disabled={retrying}
            onClick={(event) => {
              event.stopPropagation();
              onRetryRow(row.rowNumber);
            }}
          >
            {retrying ? copy.retrying : copy.retryRow}
          </button>
        ) : null}
      </span>
    </article>
  );
}

function ResultDetails({
  row,
  intlLocale,
  copy,
  onClose,
}: {
  row: V2ResultRow;
  intlLocale: string;
  copy: (typeof COPY)[keyof typeof COPY];
  onClose: () => void;
}) {
  const candidate = row.candidate;
  return (
    <aside className={styles.detailsPanel}>
      <div className={styles.panelHeading}>
        <div>
          <h3>{interpolate(copy.details, { row: row.rowNumber })}</h3>
          <p>{row.displayName}</p>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={copy.closeDetails}
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {/* Una riga senza prodotto deve spiegarsi: cosa è stato cercato, perché
          non è bastato, e come riprovare senza rifare l'intero foglio. */}
      {!row.candidate && row.attemptedQueries.length > 0 ? (
        <div className={styles.detailNoResult}>
          <strong>{copy.triedQueries}</strong>
          <ul className={styles.triedQueries}>
            {row.attemptedQueries.map((query) => (
              <li key={query}>{query}</li>
            ))}
          </ul>
          {row.gap?.detail ? <p>{row.gap.detail}</p> : null}
        </div>
      ) : null}

      <div className={styles.detailGrid}>
        <div className={styles.detailProduct}>
          <Thumbnail
            src={row.imageUrl}
            alt={candidate?.product.title ?? row.displayName}
            fallback={copy.imageMissing}
            large
          />
          <div>
            {candidate?.product.url ? (
              <a
                href={candidate.product.url}
                target="_blank"
                rel="noreferrer"
                className={styles.detailTitle}
              >
                {candidate.product.title}
              </a>
            ) : (
              <strong className={styles.detailTitle}>
                {candidate?.product.title ?? copy.candidateMissing}
              </strong>
            )}
            {candidate ? (
              <p>
                {formatPrice(row.price, row.currency, intlLocale)} /{" "}
                {row.salesUnit ?? copy.unitMissing}
                {candidate.product.moq != null
                  ? ` · MOQ ${candidate.product.moq}`
                  : ""}
                {row.sku ? ` · SKU/variante ${row.sku}` : ""}
              </p>
            ) : null}
            {candidate?.product.url ? (
              <a href={candidate.product.url} target="_blank" rel="noreferrer">
                {copy.openProduct}
              </a>
            ) : null}
          </div>
        </div>

        <dl className={styles.detailFacts}>
          {row.searchQuery ? (
            <>
              <dt>{copy.query}</dt>
              <dd>{row.searchQuery}</dd>
            </>
          ) : null}
          <dt>{copy.columns.status}</dt>
          <dd>{copy.sections[row.section].title}</dd>
          {row.source?.originalCells.length ? (
            <>
              <dt>{copy.original}</dt>
              <dd>{row.source.originalCells.join(" · ")}</dd>
            </>
          ) : null}
          {row.error ? (
            <>
              <dt>{copy.error}</dt>
              <dd>{row.error}</dd>
            </>
          ) : null}
        </dl>
      </div>

      {row.actions.length > 0 ? (
        <DetailList
          title={copy.actionsTitle}
          items={row.actions.map(
            (action) =>
              `${copy.actionTypes[action.type]}${
                action.detail ? ` — ${action.detail}` : ""
              }`
          )}
          tone="attention"
        />
      ) : null}
      {row.reviewIssues.length > 0 ? (
        <DetailList
          title={copy.technicalChecks}
          items={row.reviewIssues.map((issue) =>
            [issue.code, issue.attributeKey, issue.detail]
              .filter(Boolean)
              .join(" · ")
          )}
        />
      ) : null}
      {row.automaticIssues.length > 0 ? (
        <DetailList
          title={copy.automaticChecks}
          items={row.automaticIssues.map((issue) =>
            [issue.code, issue.attributeKey, issue.detail]
              .filter(Boolean)
              .join(" · ")
          )}
        />
      ) : null}
      {row.candidates.length > 1 ? (
        <DetailList
          title={copy.alternatives}
          items={row.candidates
            .filter((entry) => entry !== row.candidate)
            .slice(0, 5)
            .map(
              (entry) =>
                `#${entry.rank} ${entry.product.title} · ${formatPrice(
                  entry.product.promotionPrice ?? entry.product.price,
                  entry.product.currency,
                  intlLocale
                )}`
            )}
        />
      ) : null}
    </aside>
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
