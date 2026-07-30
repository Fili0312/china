import type { Locale } from "@china/shared";
import { currentLocale } from "./request-locale";

/**
 * I testi che l'API mostra a chi usa la piattaforma.
 *
 * Qui stanno solo i messaggi **destinati a una persona**: errori che finiscono
 * a schermo e intestazioni dei fogli Excel. I log restano in italiano e non
 * passano di qui — li legge chi mantiene il sistema, non chi lo usa, e
 * tradurli renderebbe più difficile cercarli.
 *
 * L'inglese è la sorgente di verità delle chiavi: le altre lingue sono
 * tipizzate su di esso, quindi una chiave aggiunta e non tradotta è un errore
 * di compilazione.
 */
const en = {
  /* Non trovato ------------------------------------------------------- */
  "err.clientNotFound": "Client not found: {id}",
  "err.datasetNotFound": "File not found: {id}",
  "err.analysisNotFound": "Analysis not found: {id}",
  "err.jobNotFound": "Search not found: {id}",
  "err.rowNotFound": "Row not found: {id}",
  "err.clarificationNotFound": "Question not found: {id}",
  "err.notForThisClient": "{resource} not found for this client.",
  "err.productNotFound": "Product not found for this client.",
  "err.productGone": "Product no longer in memory.",
  "err.productAfterRefresh": "Product not found after the refresh.",
  "err.pipelineNotFound": "Run not found: {id}",
  "err.pipelineNotWaiting": "This run is not waiting for answers.",

  /* Nomi delle risorse, usati da `err.notForThisClient` ---------------- */
  "resource.file": "File",
  "resource.analysis": "Analysis",
  "resource.job": "Search",
  "resource.row": "Row",
  "resource.pipeline": "Run",

  /* Richieste non valide ----------------------------------------------- */
  "err.analysisOtherFile":
    "The analysis you selected belongs to another file: run the review again on this one.",
  "err.reviewNoRows": "The review contains no rows.",
  "err.jobNoAnalysis": "This search has no linked review: it cannot be run again.",
  "err.rerunEmptyScope":
    "No rows to redo with the scope «{scope}»: the previous search has none of that kind.",
  "err.rerunRowsGone": "The rows to redo no longer exist in the review.",
  "err.refreshTaobaoOnly": "Checking the price right now is only available for Taobao products.",
  "err.clarificationNeedsAnswer": "An answer is needed, or «stop asking».",
  "err.tooManySimilarNames": "Too many clients with a similar name: pick a more specific one.",
  "err.needNameColumn": "At least one column must be mapped to the product name.",
  "err.fileNoRows": "The file contains no rows to process.",
  "err.noFile": "No file received.",
  "err.rowNoAnalysis": "This row has no analysis to correct: run the AI analysis again.",
  "err.invalidCorrection": "Invalid correction: {reason}",
  "err.verifyFailed": "Check failed: {reason}",
  "err.refineFailed": "Rewriting the queries failed: {reason}",
  "err.noCookies":
    "No cookie recognised: paste the JSON cookie export from taobao.com, not the Cookie header alone.",
  "err.unexpected": "Unexpected error",

  /* Chiavi di configurazione mancanti ---------------------------------- */
  "err.rapidapiMissing": "RAPIDAPI_KEY is not configured: the price cannot be checked at source.",
  "err.claudeKeyMissing": "CLAUDE_API_KEY is not configured: coherence cannot be checked.",
  "err.deepseekMissing":
    "DEEP_SEEK_API is not configured: guided re-search uses DeepSeek to rewrite the queries.",

  /* Excel: nomi dei fogli ---------------------------------------------- */
  "xls.sheet.requests": "Requests",
  "xls.sheet.products": "Products",
  "xls.sheet.summary": "Summary",
  "xls.sheet.report": "Report",
  "xls.sheet.details": "Details",

  /* Excel: intestazioni del foglio «richieste» -------------------------- */
  "xls.row": "Row",
  "xls.request": "Request",
  "xls.chineseQuery": "Chinese query",
  "xls.status": "Status",
  "xls.reused": "Reused",
  "xls.reason": "Reason",
  "xls.candidates": "Candidates",
  "xls.bestTitle": "Best title",
  "xls.price": "Price",
  "xls.currency": "Currency",
  "xls.shop": "Shop",
  "xls.sales": "Sales",
  "xls.link": "Link",
  "xls.missingRequirements": "Missing requirements",

  /* Excel: intestazioni del foglio «prodotti» --------------------------- */
  "xls.rank": "Rank",
  "xls.title": "Title",
  "xls.variantPrice": "Variant price",
  "xls.reviews": "Reviews",
  "xls.rating": "Rating",
  "xls.itemId": "Item ID",
  "xls.origin": "Origin",
  "xls.compatibility": "Compatibility",
  "xls.matchedRequirements": "Matched requirements",
  "xls.warnings": "Warnings",
  "xls.lastCheck": "Last check",

  /* Excel: foglio «riepilogo» ------------------------------------------- */
  "xls.file": "File",
  "xls.totalRows": "Total rows",
  "xls.processedRows": "Rows processed",
  "xls.reusedRows": "Rows reused from memory",
  "xls.searchedRows": "Rows searched from scratch",
  "xls.failedRows": "Rows with errors",
  "xls.hwhCalls": "Taobao API calls (H-W-H)",
  "xls.dataHubCalls": "DataHub calls",
  "xls.cacheSaved": "Calls saved by the cache",
  "xls.browserSearches": "Playwright searches",
  "xls.reusedProducts": "Products reused from memory",
  "xls.newProducts": "New products stored",
  "xls.startedAt": "Started",
  "xls.finishedAt": "Finished",

  /* Excel: report per il cliente ---------------------------------------- */
  "xls.quantity": "Quantity",
  "xls.unit": "Unit",
  "xls.client": "Client",
  "xls.sourceFile": "Source file",
  "xls.markupApplied": "Markup applied",
  "xls.generatedOn": "Generated on",
  "xls.note": "Note",
  "xls.yes": "yes",
  "xls.no": "no",
  "xls.product": "Product {n}",
  "xls.priceCny": "Price {n} (CNY)",
  "xls.priceMarkedUp": "Price {n} with markup",
  "xls.linkN": "Link {n}",
  "xls.noteN": "Note {n}",
  "xls.usedBefore": "used before",
  "xls.promoPrice": "promotional price",
  "xls.compatibilityPct": "compatibility {percent}%",
  "xls.currencyNote": "CNY (Taobao/1688 prices)",
  "xls.reportDisclaimer":
    "Prices are those of the last check at the source: before a binding offer, verify them on the product page.",

  /* Nomi dei file scaricati (solo ASCII: finiscono in un header HTTP) ---- */
  "xls.fileSuffix.results": "results",
  "xls.fileSuffix.report": "report",

  /**
   * Motivi salvati sulla riga di una ricerca.
   *
   * A differenza di tutto il resto, questi testi li scrive un job che gira
   * **dopo** che la risposta HTTP è partita: non c'è una richiesta, quindi non
   * c'è una lingua scelta, e `currentLocale()` ricade sul predefinito. Restano
   * quindi nella lingua predefinita anche per chi guarda la pagina in cinese —
   * finiscono nel database, e un testo salvato ha una lingua sola. Passano
   * comunque di qui perché siano tradotti in un posto solo il giorno in cui
   * diventeranno codici risolti a schermo.
   */
  "reason.noQuery": "Row with no analysis or no query: nothing to search.",
  "reason.noChineseQuery": "No Chinese query could be derived: fix the row in the review.",
  "reason.notConfirmed": "Row not confirmed in the review: confirm it to search for it.",
  "reason.knownUnverifiable":
    "Known products present but not verifiable: RAPIDAPI_KEY is not configured.",
  "reason.nothingFound": "No product found on Taobao for this query.",
  "reason.resolvedFromLink":
    "Resolved from the link in the sheet: the customer had already chosen it.",
  "reason.variantUnresolved":
    "Product taken from the link, but the sheet does not identify which of the {count} variants: read the price on the page.",
  "reason.variantSamePrice":
    "Product taken from the link: the sheet does not say which of the {count} variants, but they all cost the same, so the price holds.",
  "reason.variantChosenByAi":
    "Product taken from the link; the variant was chosen by the model because the sheet's wording did not match any of them exactly.",
  "reason.notProcurable":
    "Not a marketplace item ({kind}): {why}. No search was spent on it.",
  "reason.refined": "Guided re-search: query rewritten from «{previous}».",
  "reason.fullSearchRequested": "Full search explicitly requested.",
  "reason.noStoredProducts": "No product stored for this variant.",
  "reason.tooFewValid":
    "Only {valid} products still valid out of {total}{why}: a full search is needed.",
  "reason.reusable": "{valid} known products still valid: refreshed instead of searched.",
  "reason.rowLabel": "Row {number}",

  /* Spedizione interna in Cina, come la espone la fonte ------------------ */
  "ship.free": "free shipping",
  "ship.fee": "shipping {fee}",
} as const;

type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "err.clientNotFound": "未找到客户：{id}",
  "err.datasetNotFound": "未找到文件：{id}",
  "err.analysisNotFound": "未找到分析记录：{id}",
  "err.jobNotFound": "未找到搜索记录：{id}",
  "err.rowNotFound": "未找到该行：{id}",
  "err.clarificationNotFound": "未找到该问题：{id}",
  "err.notForThisClient": "该客户下未找到{resource}。",
  "err.productNotFound": "该客户下未找到此产品。",
  "err.productGone": "该产品已不在记忆库中。",
  "err.productAfterRefresh": "更新后未找到该产品。",
  "err.pipelineNotFound": "未找到该次处理：{id}",
  "err.pipelineNotWaiting": "本次处理当前并未在等待回答。",

  "resource.file": "文件",
  "resource.analysis": "分析记录",
  "resource.job": "搜索记录",
  "resource.row": "行",
  "resource.pipeline": "处理",

  "err.analysisOtherFile": "所选的分析属于另一个文件：请对当前文件重新执行核对。",
  "err.reviewNoRows": "该分析不包含任何行。",
  "err.jobNoAnalysis": "此次搜索没有关联的分析记录：无法重新运行。",
  "err.rerunEmptyScope": "按「{scope}」范围没有需要重做的行：上一次搜索中不存在此类行。",
  "err.rerunRowsGone": "需要重做的行在分析记录中已不存在。",
  "err.refreshTaobaoOnly": "立即核对价格仅适用于淘宝产品。",
  "err.clarificationNeedsAnswer": "请填写回答，或选择「不再询问」。",
  "err.tooManySimilarNames": "已有太多名称相近的客户：请使用更具体的名称。",
  "err.needNameColumn": "至少需要将一列对应到产品名称。",
  "err.fileNoRows": "该文件没有可处理的行。",
  "err.noFile": "未收到文件。",
  "err.rowNoAnalysis": "该行没有可修改的分析结果：请重新运行 AI 分析。",
  "err.invalidCorrection": "修改无效：{reason}",
  "err.verifyFailed": "检查失败：{reason}",
  "err.refineFailed": "重写搜索词失败：{reason}",
  "err.noCookies": "未识别到任何 cookie：请粘贴 taobao.com 导出的 JSON 格式 cookie，而不是单独的 Cookie 头。",
  "err.unexpected": "意外错误",

  "err.rapidapiMissing": "未配置 RAPIDAPI_KEY：无法在来源处核对价格。",
  "err.claudeKeyMissing": "未配置 CLAUDE_API_KEY：无法执行一致性检查。",
  "err.deepseekMissing": "未配置 DEEP_SEEK_API：引导式重新搜索需要 DeepSeek 来重写搜索词。",

  "xls.sheet.requests": "询价",
  "xls.sheet.products": "产品",
  "xls.sheet.summary": "汇总",
  "xls.sheet.report": "报告",
  "xls.sheet.details": "明细",

  "xls.row": "行",
  "xls.request": "询价内容",
  "xls.chineseQuery": "中文搜索词",
  "xls.status": "状态",
  "xls.reused": "是否复用",
  "xls.reason": "原因",
  "xls.candidates": "候选数",
  "xls.bestTitle": "最佳标题",
  "xls.price": "价格",
  "xls.currency": "币种",
  "xls.shop": "店铺",
  "xls.sales": "销量",
  "xls.link": "链接",
  "xls.missingRequirements": "缺少的要求",

  "xls.rank": "排名",
  "xls.title": "标题",
  "xls.variantPrice": "款式价格",
  "xls.reviews": "评价数",
  "xls.rating": "评分",
  "xls.itemId": "商品 ID",
  "xls.origin": "来源",
  "xls.compatibility": "匹配度",
  "xls.matchedRequirements": "已满足的要求",
  "xls.warnings": "提示",
  "xls.lastCheck": "最近核对",

  "xls.file": "文件",
  "xls.totalRows": "总行数",
  "xls.processedRows": "已处理行数",
  "xls.reusedRows": "复用记忆库的行数",
  "xls.searchedRows": "重新搜索的行数",
  "xls.failedRows": "出错的行数",
  "xls.hwhCalls": "Taobao API 调用次数（H-W-H）",
  "xls.dataHubCalls": "DataHub 调用次数",
  "xls.cacheSaved": "缓存节省的调用次数",
  "xls.browserSearches": "Playwright 搜索次数",
  "xls.reusedProducts": "复用记忆库的产品数",
  "xls.newProducts": "新保存的产品数",
  "xls.startedAt": "开始时间",
  "xls.finishedAt": "结束时间",

  "xls.quantity": "数量",
  "xls.unit": "单位",
  "xls.client": "客户",
  "xls.sourceFile": "来源文件",
  "xls.markupApplied": "已加价",
  "xls.generatedOn": "生成时间",
  "xls.note": "备注",
  "xls.yes": "是",
  "xls.no": "否",
  "xls.product": "产品 {n}",
  "xls.priceCny": "价格 {n}（CNY）",
  "xls.priceMarkedUp": "加价后价格 {n}",
  "xls.linkN": "链接 {n}",
  "xls.noteN": "备注 {n}",
  "xls.usedBefore": "此前用过",
  "xls.promoPrice": "促销价",
  "xls.compatibilityPct": "匹配度 {percent}%",
  "xls.currencyNote": "CNY（淘宝/1688 价格）",
  "xls.reportDisclaimer": "价格为最近一次在来源处核对的结果：在提供具有约束力的报价前，请在商品页面再次确认。",

  "xls.fileSuffix.results": "results",
  "xls.fileSuffix.report": "report",

  "reason.noQuery": "该行没有分析结果或搜索词：无内容可搜索。",
  "reason.noChineseQuery": "无法得出中文搜索词：请在核对阶段修正该行。",
  "reason.notConfirmed": "该行在核对阶段未确认：确认后才会搜索。",
  "reason.knownUnverifiable": "存在已知产品但无法核验：未配置 RAPIDAPI_KEY。",
  "reason.nothingFound": "按此搜索词在淘宝未找到任何产品。",
  "reason.resolvedFromLink": "按表格中的链接直接获取：客户已经选定。",
  "reason.variantUnresolved": "商品来自链接，但表格无法确定是 {count} 个规格中的哪一个：请到页面上读取价格。",
  "reason.variantSamePrice": "商品来自链接：表格未指明是 {count} 个规格中的哪一个，但它们价格相同，故价格有效。",
  "reason.variantChosenByAi": "商品来自链接；表格的写法与任一规格都不完全一致，规格由模型判定。",
  "reason.notProcurable": "非市场在售商品（{kind}）：{why}。未为其花费任何搜索。",
  "reason.refined": "引导式重新搜索：搜索词由「{previous}」重写而来。",
  "reason.fullSearchRequested": "已明确要求执行完整搜索。",
  "reason.noStoredProducts": "该款式没有已保存的产品。",
  "reason.tooFewValid": "{total} 个产品中仅 {valid} 个仍然有效{why}：需要执行完整搜索。",
  "reason.reusable": "{valid} 个已知产品仍然有效：已更新而非重新搜索。",
  "reason.rowLabel": "第 {number} 行",

  "ship.free": "包邮",
  "ship.fee": "运费 {fee}",
};

const it: Record<MessageKey, string> = {
  "err.clientNotFound": "Cliente non trovato: {id}",
  "err.datasetNotFound": "File non trovato: {id}",
  "err.analysisNotFound": "Analisi non trovata: {id}",
  "err.jobNotFound": "Ricerca non trovata: {id}",
  "err.rowNotFound": "Riga non trovata: {id}",
  "err.clarificationNotFound": "Domanda non trovata: {id}",
  "err.notForThisClient": "{resource} non trovato per questo cliente.",
  "err.productNotFound": "Prodotto non trovato per questo cliente.",
  "err.productGone": "Prodotto non più presente in memoria.",
  "err.productAfterRefresh": "Prodotto non trovato dopo l'aggiornamento.",
  "err.pipelineNotFound": "Elaborazione non trovata: {id}",
  "err.pipelineNotWaiting": "Questa elaborazione non sta aspettando risposte.",

  "resource.file": "File",
  "resource.analysis": "Analisi",
  "resource.job": "Ricerca",
  "resource.row": "Riga",
  "resource.pipeline": "Elaborazione",

  "err.analysisOtherFile":
    "L'analisi indicata appartiene a un altro file: rifai la revisione su questo.",
  "err.reviewNoRows": "La revisione non contiene righe.",
  "err.jobNoAnalysis":
    "Questa ricerca non ha una revisione collegata: non si può rilanciare.",
  "err.rerunEmptyScope":
    "Nessuna riga da rifare con l'ambito «{scope}»: la ricerca precedente non ne ha di quel tipo.",
  "err.rerunRowsGone": "Le righe da rifare non esistono più nella revisione.",
  "err.refreshTaobaoOnly": "La verifica immediata è disponibile solo per i prodotti Taobao.",
  "err.clarificationNeedsAnswer": "Serve una risposta, oppure «non rispondere più».",
  "err.tooManySimilarNames":
    "Troppi clienti con un nome simile: scegline uno più specifico.",
  "err.needNameColumn": "Serve almeno una colonna associata al nome prodotto.",
  "err.fileNoRows": "Il file non contiene righe da elaborare.",
  "err.noFile": "Nessun file ricevuto.",
  "err.rowNoAnalysis":
    "Questa riga non ha un'analisi da correggere: rilancia l'analisi IA.",
  "err.invalidCorrection": "Correzione non valida: {reason}",
  "err.verifyFailed": "Verifica non riuscita: {reason}",
  "err.refineFailed": "Riscrittura delle query non riuscita: {reason}",
  "err.noCookies":
    "Nessun cookie riconosciuto: incolla l'esportazione JSON dei cookie di taobao.com, non il solo header Cookie.",
  "err.unexpected": "Errore imprevisto",

  "err.rapidapiMissing":
    "RAPIDAPI_KEY non configurata: impossibile verificare il prezzo alla fonte.",
  "err.claudeKeyMissing":
    "CLAUDE_API_KEY non configurata: impossibile verificare la coerenza.",
  "err.deepseekMissing":
    "DEEP_SEEK_API non configurata: la ri-ricerca guidata usa DeepSeek per riscrivere le query.",

  "xls.sheet.requests": "Richieste",
  "xls.sheet.products": "Prodotti",
  "xls.sheet.summary": "Riepilogo",
  "xls.sheet.report": "Report",
  "xls.sheet.details": "Dettagli",

  "xls.row": "Riga",
  "xls.request": "Richiesta",
  "xls.chineseQuery": "Query cinese",
  "xls.status": "Stato",
  "xls.reused": "Riusata",
  "xls.reason": "Motivo",
  "xls.candidates": "Candidati",
  "xls.bestTitle": "Miglior titolo",
  "xls.price": "Prezzo",
  "xls.currency": "Valuta",
  "xls.shop": "Negozio",
  "xls.sales": "Vendite",
  "xls.link": "Link",
  "xls.missingRequirements": "Requisiti mancanti",

  "xls.rank": "Posizione",
  "xls.title": "Titolo",
  "xls.variantPrice": "Prezzo variante",
  "xls.reviews": "Recensioni",
  "xls.rating": "Voto",
  "xls.itemId": "Item ID",
  "xls.origin": "Provenienza",
  "xls.compatibility": "Compatibilità",
  "xls.matchedRequirements": "Requisiti soddisfatti",
  "xls.warnings": "Avvisi",
  "xls.lastCheck": "Ultimo controllo",

  "xls.file": "File",
  "xls.totalRows": "Righe totali",
  "xls.processedRows": "Righe elaborate",
  "xls.reusedRows": "Righe riusate dalla memoria",
  "xls.searchedRows": "Righe cercate da zero",
  "xls.failedRows": "Righe con errore",
  "xls.hwhCalls": "Chiamate Taobao API (H-W-H)",
  "xls.dataHubCalls": "Chiamate DataHub",
  "xls.cacheSaved": "Chiamate risparmiate dalla cache",
  "xls.browserSearches": "Ricerche Playwright",
  "xls.reusedProducts": "Prodotti riusati dalla memoria",
  "xls.newProducts": "Prodotti nuovi salvati",
  "xls.startedAt": "Avvio",
  "xls.finishedAt": "Fine",

  "xls.quantity": "Quantità",
  "xls.unit": "Unità",
  "xls.client": "Cliente",
  "xls.sourceFile": "File di partenza",
  "xls.markupApplied": "Ricarico applicato",
  "xls.generatedOn": "Generato il",
  "xls.note": "Nota",
  "xls.yes": "sì",
  "xls.no": "no",
  "xls.product": "Prodotto {n}",
  "xls.priceCny": "Prezzo {n} (CNY)",
  "xls.priceMarkedUp": "Prezzo {n} ricaricato",
  "xls.linkN": "Link {n}",
  "xls.noteN": "Nota {n}",
  "xls.usedBefore": "usato in precedenza",
  "xls.promoPrice": "prezzo promozionale",
  "xls.compatibilityPct": "compatibilità {percent}%",
  "xls.currencyNote": "CNY (prezzi Taobao/1688)",
  "xls.reportDisclaimer":
    "I prezzi sono quelli dell'ultimo controllo alla fonte: prima di un'offerta vincolante, verificarli dalla scheda prodotto.",

  "xls.fileSuffix.results": "results",
  "xls.fileSuffix.report": "report",

  "reason.noQuery": "Riga senza analisi o senza query: niente da cercare.",
  "reason.noChineseQuery": "Nessuna query cinese ricavabile: correggi la riga nella revisione.",
  "reason.notConfirmed": "Riga non confermata nella revisione: confermala per cercarla.",
  "reason.knownUnverifiable":
    "Prodotti noti presenti ma non verificabili: RAPIDAPI_KEY non configurata.",
  "reason.nothingFound": "Nessun prodotto trovato su Taobao per questa query.",
  "reason.resolvedFromLink":
    "Preso dal link del foglio: il cliente lo aveva già scelto.",
  "reason.variantUnresolved":
    "Prodotto preso dal link, ma il foglio non dice quale delle {count} varianti: leggi il prezzo sulla pagina.",
  "reason.variantSamePrice":
    "Prodotto preso dal link: il foglio non dice quale delle {count} varianti, ma costano tutte uguale, quindi il prezzo vale.",
  "reason.variantChosenByAi":
    "Prodotto preso dal link; la variante l'ha scelta il modello, perché il foglio non la scrive come nessuna di quelle in vendita.",
  "reason.notProcurable":
    "Non è un articolo da marketplace ({kind}): {why}. Nessuna ricerca spesa.",
  "reason.refined": "Ri-ricerca guidata: query riscritta da «{previous}».",
  "reason.fullSearchRequested": "Ricerca completa richiesta esplicitamente.",
  "reason.noStoredProducts": "Nessun prodotto salvato per questa variante.",
  "reason.tooFewValid":
    "Solo {valid} prodotti ancora validi su {total}{why}: serve una ricerca completa.",
  "reason.reusable": "{valid} prodotti noti ancora validi: aggiornati invece di ricercati.",
  "reason.rowLabel": "Riga {number}",

  "ship.free": "spedizione gratuita",
  "ship.fee": "spedizione {fee}",
};

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, zh, it };

/**
 * Il testo nella lingua della richiesta in corso.
 *
 * Non prende `locale` come parametro di proposito: il punto di questo modulo è
 * che chi scrive un messaggio d'errore in fondo a un servizio non debba avere
 * la lingua a portata di mano per farlo bene.
 */
export function t(
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>
): string {
  const template = DICTIONARIES[currentLocale()][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole
  );
}

export type ApiMessageKey = MessageKey;
