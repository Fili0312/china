/**
 * Inglese: la lingua predefinita e la sorgente di verità delle chiavi.
 *
 * Le altre lingue sono tipizzate su questo oggetto, quindi una chiave aggiunta
 * qui e dimenticata altrove è un errore di compilazione, non una stringa
 * mancante scoperta dall'utente.
 *
 * I segnaposto sono `{nome}` e vengono sostituiti da `t()`. Nelle frasi con
 * numeri variabili la forma singolare e plurale sono chiavi separate: il
 * cinese non declina, l'inglese e l'italiano sì, e una sola chiave costringe a
 * scrivere «1 righe» in qualche lingua.
 */
export const en = {
  /* Applicazione ------------------------------------------------------- */
  "app.title": "Taobao Scouting",
  "app.description": "Per-client product scouting on Taobao, from request sheet to quote.",
  "lang.label": "Language",

  /* Schermata di errore ------------------------------------------------ */
  "error.title": "Something broke on this page",
  "error.body":
    "If an update was published a moment ago, your browser is still running the previous version: reloading once fixes it. Your corrections to the Chinese queries are saved.",
  "error.retry": "Retry without reloading",
  "error.reload": "Reload the page",

  /* Valori generici ---------------------------------------------------- */
  "common.choose": "— choose —",
  "common.none": "—",
  "common.never": "never",
  "common.loading": "loading…",
  "common.close": "close",
  "common.open": "open",
  "common.measure": "measure",

  /* Campi del foglio --------------------------------------------------- */
  "field.name": "Product name",
  "field.spec": "Specifications",
  "field.title": "Title already given",
  "field.category": "Category",
  "field.brand": "Brand",
  "field.model": "Model / code",
  "field.quantity": "Quantity",
  "field.unit": "Unit",
  "field.material": "Material",
  "field.certifications": "Certifications",
  "field.targetPrice": "Target price",
  "field.notes": "Notes",
  "field.referenceUrl": "Reference link",
  "field.ignore": "— ignore —",

  /* Stati della riga analizzata ---------------------------------------- */
  "state.NEW_PRODUCT": "New product",
  "state.NEW_VARIANT": "New variant",
  "state.KNOWN_PRODUCT": "Already known product",
  "state.NEEDS_REVIEW": "Needs checking",
  "state.ANALYSIS_FAILED": "AI analysis failed",
  "state.READY": "Ready to search",

  /* Stati della riga in ricerca ---------------------------------------- */
  "rowStatus.PENDING": "Waiting",
  "rowStatus.REFRESHING": "Refreshing prices",
  "rowStatus.SEARCHING_API": "API search",
  "rowStatus.SEARCHING_BROWSER": "Playwright search",
  "rowStatus.DONE": "Done",
  "rowStatus.SKIPPED": "Skipped",
  "rowStatus.FAILED": "Error",

  /* Provenienza dei dati ----------------------------------------------- */
  "source.hwh": "Taobao API",
  "source.api": "DataHub",
  "source.elim": "ElimAPI",
  "source.playwright": "Playwright",
  "source.excel": "Excel",
  "source.memory": "Memory",

  /* Marketplace -------------------------------------------------------- */
  "platform.taobao": "Taobao",
  "platform.1688": "1688",

  /* Ambito del rilancio ------------------------------------------------ */
  "rerunScope.all": "every row",
  "rerunScope.failed": "only rows with errors",
  "rerunScope.empty": "only rows with no results",

  /* Avvisi dell'analisi ------------------------------------------------ */
  "warning.AMBIGUOUS_MEASURE": "ambiguous measurement",
  "warning.AMBIGUOUS_MODEL": "ambiguous model",
  "warning.AMBIGUOUS_UNIT": "ambiguous unit",
  "warning.AMBIGUOUS_QUANTITY": "ambiguous quantity",
  "warning.MULTIPLE_PRODUCTS": "several products in one row",
  "warning.MISSING_INFO": "missing information",
  "warning.UNCLEAR_TEXT": "unclear text",
  "warning.OTHER": "other",

  /* Intestazione ------------------------------------------------------- */
  "scouting.heading": "Taobao Scouting",
  "scouting.subtitle": "One client, one request sheet, one marketplace: Taobao.",
  "scouting.apiMissing":
    "RAPIDAPI_KEY is not configured: searching through the API is unavailable.",

  /* 1. Cliente --------------------------------------------------------- */
  "client.step": "1. Client",
  "client.select": "Client",
  "client.option": "{name} ({datasets} files · {jobs} searches)",
  "client.new": "New client",
  "client.newPlaceholder": "client name",
  "client.create": "Create client",
  "client.hint":
    "Files, analyses and searches belong to the selected client and are invisible to the others. Product memory, on the other hand, is shared internally: if a part has already been looked up, it is not searched again (and not paid for again).",

  /* Storico del cliente ------------------------------------------------ */
  "history.heading": "History for {name}",
  "history.hint":
    "Reopening a search or a review that has already been run <strong>costs nothing</strong>: results and analyses are stored, neither Claude nor RapidAPI is called again.",
  "history.col.search": "Search",
  "history.col.file": "File",
  "history.col.rows": "Rows",
  "history.col.usage": "Usage",
  "history.col.status": "Status",
  "history.errors": "{count} errors",
  "history.usage": "{calls} calls - {cached} from cache - {products} products",
  "history.reopen": "reopen",
  "history.excel": "Excel",
  "history.reviews": "Reviews of the open file",
  "history.reviewTitle": "{calls} calls, {cached} from cache, about ${cost}",
  "history.reviewChip": "{date} - {analyzed}/{total} rows",

  /* 2. File ------------------------------------------------------------ */
  "file.step": "2. File upload",
  "file.existing": "Files already uploaded",
  "file.option": "{name} · {rows} rows · {date}",
  "file.summary": "{rows} rows · sheet {sheet}",
  "file.columns": "Detected columns",
  "file.col.column": "Column",
  "file.col.header": "Header",
  "file.col.samples": "Samples",
  "file.col.field": "Field",

  /* 3. Analisi --------------------------------------------------------- */
  "analysis.step": "3. AI analysis of the requests",
  "analysis.hint":
    "Every row is read by the AI once only: identical rows and files already analysed reuse the stored analysis without spending a call.",
  "analysis.engine": "engine: {provider} · {model}",
  "analysis.engineTitle": "Prompt {version}",
  "analysis.engineMissing": "Engine key not configured: the analysis will not start.",
  "analysis.budget": "trial budget: ${remaining} left of ${limit}",
  "analysis.budgetTitle": "Spending cap for the DeepSeek trial (DEEPSEEK_TEST_BUDGET_USD)",
  "analysis.run": "Analyse the requests",
  "analysis.running": "Analysing…",
  "analysis.needName": "Assign at least one column to «Product name».",

  /* 4. Revisione ------------------------------------------------------- */
  "review.step": "4. Review of the requests",
  "review.analysed": "{analysed} / {total} rows analysed",
  "review.counts": "{ready} ready · {warnings} with warnings · {failed} not analysable",
  "review.usage": "{calls} calls · {cached} from cache · {tokens} tokens · ≈ ${cost}",
  "review.engineTitle": "Prompt {version} — analysis engine used for this session",
  "review.hint":
    "Only what actually blocks the search stops a row: no Chinese query, several products in the same row, or confidence below the threshold. A measurement without a unit does <strong>not</strong> stop the row — the query goes out as the original Chinese text, so the ambiguity does not change what is searched: it stays as a warning next to the product found.",
  "review.pending": "<strong>{count} rows</strong> are waiting for confirmation.",
  "review.confirming": "Confirming… {done}/{total}",
  "review.confirmAll": "Confirm all {count}",
  "review.col.row": "Row",
  "review.col.original": "Original text",
  "review.col.family": "Family / variant",
  "review.col.query": "Chinese query",
  "review.col.specs": "Required specifications",
  "review.col.confidence": "Confidence",
  "review.col.state": "State / memory",
  "review.residual": "residual: {values}",
  "review.residualTitle":
    "Fragments of the text that entered the identity because the analysis had not extracted them: they are what keeps two similar variants apart",
  "review.noQuery": "none",
  "review.model": "model {model}",
  "review.edited": "corrected",
  "review.cached": "from cache",
  "review.cachedTitle": "Analysis reused: no call spent",
  "review.toCheck": "to check",
  "review.memory": "{valid}/{total} valid products · last search {date}",
  "review.memoryFamily": "{count} known variants of the same family",
  "review.edit": "correct",
  "review.noAnalysis": "This row has no analysis.",
  "review.noAnalysisHint": "Fix the column mapping and run the analysis again.",
  "review.submitted": "Text sent to the analysis:",
  "review.dimensions": "Measurements: {dimensions} — Specifications: {specs}",
  "review.hardRequirements": " — Required: {requirements}",
  "review.variant": "variant: {variant}",
  "review.referenceUrl": "Link already in the sheet:",
  "review.save": "Save corrections",
  "review.saveConfirm": "Save and confirm for the search",

  /* Campi modificabili -------------------------------------------------- */
  "editable.productFamily": "Family (readable)",
  "editable.familyKey": "Family key",
  "editable.variantKey": "Variant label",
  "editable.productNameChinese": "Chinese name",
  "editable.productNameEnglish": "English name",
  "editable.model": "Model / code",
  "editable.material": "Material",
  "editable.color": "Colour",
  "editable.searchQueryChinese": "Chinese query (used on Taobao)",
  "editable.unit": "Unit",
  "editable.requestedQuantity": "Requested quantity",

  /* Domande dell'IA ----------------------------------------------------- */
  "clarify.step": "Questions from the AI",
  "clarify.hint":
    "When something does not add up during the analysis (unit of measure, model) the doubt becomes a question — <strong>one per product family</strong>, at most 5 new ones per analysis, never one already answered. Every answer is stored and used in later analyses: run the analysis again to apply it to the blocked rows. Doubts affecting a single row (for example several products in one row) do not raise questions: they are fixed during the review.",
  "clarify.empty": "No open questions: the AI has everything it needs.",
  "clarify.rowsOne": "{count} row",
  "clarify.rowsMany": "{count} rows",
  "clarify.fromVerify": "from the check",
  "clarify.fromVerifyTitle": "Raised by the coherence check on the results",
  "clarify.example": "e.g.: {example}",
  "clarify.placeholder": "short answer (e.g. «60*60 panels are in cm»)",
  "clarify.save": "Save answer",
  "clarify.dismiss": "stop asking",
  "clarify.dismissTitle": "Archive: this question will not be asked again",
  "clarify.showTop": "show only the 5 most important",
  "clarify.showAll": "show all {count} questions",
  "clarify.hideAnswered": "hide the acquired knowledge",
  "clarify.showAnswered": "acquired knowledge: {count} answers",
  "clarify.question": "Q:",
  "clarify.answer": "A:",
  "clarify.appliedOne": " — used in {count} analysis",
  "clarify.appliedMany": " — used in {count} analyses",

  /* 6. Ricerca ---------------------------------------------------------- */
  "search.step": "6. Search on Taobao",
  "search.sourceTitle": "Active search source (TAOBAO_PRIMARY_SEARCH)",
  "search.source": "source: {source}",
  "search.forceFull": "Full search even for variants already known",
  "search.maxCandidates": "Candidates per row",
  "search.detailTopN": "Details for the top",
  "search.reviewTopN": "Reviews for the top",
  "search.hint":
    "Every row costs <strong>one</strong> search call per variant, plus one call for each detail page and each review page requested. Variants already known are not searched again: only their price and availability are refreshed.",
  "search.start": "Start the search on {count} ready requests",

  /* 7. Risultati -------------------------------------------------------- */
  "results.step": "7. Results",
  "results.progress": "{processed} / {total} rows",
  "results.breakdown": "{reused} reused from memory · {searched} searched · {failed} with errors",
  "results.hwhTitle": "Search: Taobao API by H-W-H",
  "results.hwhCalls": "{count} Taobao API calls",
  "results.apiTitle": "Search / details: Taobao DataHub",
  "results.apiCalls": "{count} DataHub calls",
  "results.cacheHits": "{count} saved by the cache",
  "results.reusedProducts": "{count} products from memory",
  "results.newProducts": "{count} new products",
  "results.browserCalls": "{count} Playwright searches",
  "results.refresh": "Refresh",
  "results.export": "8. Download the results as Excel",
  "results.verifyTitle":
    "Claude rereads the request and the candidates and says whether EVERYTHING is coherent; doubts become stored questions",
  "results.verifying": "Checking coherence…",
  "results.verify": "AI coherence check (top 3 per row)",
  "results.verifySummary":
    "{checked} judged: {coherent} coherent · {incoherent} not · {unsure} unsure",
  "results.verifyQuestions": " · {count} questions opened",
  "results.verifySkipped": " · {count} already checked",
  "results.refineTitle":
    "For rows without a coherent product, the AI rewrites the query from the reasons for the failure and searches again",
  "results.refining": "Searching again…",
  "results.refine": "Improve the rows without a coherent product",
  "results.refineSummary":
    "{refined}/{problematic} rows redone · {recovered} recovered · {products} new products · {calls} DataHub calls · ≈ ${cost}",
  "results.markupTitle": "Percentage added to the prices in the client report",
  "results.markup": "Cost markup",
  "results.report": "Download the Excel report (quantities + 3 best links, prices +{markup}%)",
  "results.rerunScope": "Redo the search on",
  "results.rerunTitle": "Query Taobao again, ignoring the products already in memory",
  "results.rerun": "Redo through the API on {count} rows",
  "results.rerunHint":
    "This starts a new search that inherits the settings of this one: the previous one stays in the history, so the two results can be compared. Rows confirmed by hand in the meantime are included.",
  "results.row": "row {number}",
  "results.reused": "reused",
  "results.query": "query: {query}",
  "results.engineStatus": "{engine}: {status} ({count})",
  "results.empty": "No product found for this request.",
  "results.showTop": "show only the top 3",
  "results.showAll": "show all {count}",

  /* Scheda prodotto ------------------------------------------------------ */
  "card.usedBefore": "used before",
  "card.usedBeforeTitle":
    "This product's link was already in the Excel sheet: it is the starting point",
  "card.platformTitle": "Marketplace it comes from",
  "card.compatibility": "compatibility {percent}%",
  "card.compatibilityTitle":
    "Technical compatibility: how many requirements of the request are found in the product",
  "card.coherenceTitle": "AI check (confidence {percent}%)",
  "card.coherent": "checked: coherent",
  "card.incoherent": "checked: NOT coherent",
  "card.unsure": "checked: unsure",
  "card.coherenceIssues": "AI check: {issues}",
  "card.promo": "on promotion",
  "card.promoTitle": "Promotional price",
  "card.moq": "minimum {count} pcs",
  "card.variantPrice": "variant {price}",
  "card.sales": "{count} sales",
  "card.reviews": "{count} reviews",
  "card.rating": "rating {rating}",
  "card.noShop": "seller not stated",
  "card.checkedAt": "checked on {date}",
  "card.staleTitle": "The price may have changed since then: use «check the price now»",
  "card.matched": "compatible: {list}",
  "card.missing": "missing: {list}",
  "card.changed": "changed since the last check: {list}",
  "card.checking": "checking…",
  "card.checkNow": "check the price now",
  "card.checkNowTitle":
    "Rereads the listing at the source without cache and refreshes price and availability",
  "card.hideHistory": "hide history",
  "card.showHistory": "price history",
  "card.unavailableNow": "The product can no longer be reached at the source.",
  "card.priceChanged": "Price changed: was {before}, now {after}.",
  "card.priceConfirmed": "Price checked just now: it is the one shown.",
  "card.historyEmpty":
    "No change recorded. First seen on {first}, last checked {last}: since then price and availability are unchanged.",
  "card.historyWas": " — was {price} {currency}",
  "card.historyUnavailable": " — unavailable",

  /* Memoria interna ------------------------------------------------------ */
  "memory.step": "Product history (internal memory)",
  "memory.hint":
    "Every analysed product ends up here. If a new file asks for a variant that matches (measurements, colour, specifications), the stored products are <strong>reused without a new search</strong>: only price and availability are refreshed.",
  "memory.closedHint":
    "The variants already searched and their products: consulting them costs nothing.",
  "memory.placeholder": "search by name, family or query…",
  "memory.searching": "searching…",
  "memory.search": "Search",
  "memory.empty": "No variant in memory for this search.",
  "memory.col.variant": "Variant",
  "memory.col.family": "Family",
  "memory.col.products": "Products",
  "memory.col.searches": "Searches",
  "memory.col.lastSearch": "Last search",
  "memory.col.topProduct": "Best product",

  /* ====================================================================== */
  /* Scouting v2: l'elaborazione che si guida da sola                        */
  /* ====================================================================== */

  "v2.heading": "Quotation from a request sheet",
  "v3.heading": "Quotation from a request sheet (v3)",
  "v2.subtitle":
    "Drop the sheet in. The rest — reading it, understanding every line, searching Taobao, checking the results — happens on its own. You are asked only what cannot be worked out.",
  "v2.openV1": "Step-by-step version",

  /* Passo 1: cliente e file --------------------------------------------- */
  "v2.client.step": "Who is this quotation for?",
  "v2.client.hint":
    "Files, searches and results belong to the client you pick and stay invisible to the others.",
  "v2.client.existing": "Existing client",
  "v2.client.new": "or a new one",
  "v2.drop.title": "Drop the request sheet here",
  "v2.drop.hint": "Excel or CSV — .xlsx, .xls, .xlsm, .csv",
  "v2.drop.browse": "choose a file",
  "v2.drop.reading": "Reading the sheet…",
  "v2.drop.needClient": "Pick a client first: the file belongs to someone.",

  /* Passo 2: preventivo -------------------------------------------------- */
  "v2.estimate.title": "Before starting",
  "v2.estimate.rows": "{usable} usable rows of {total}",
  "v2.estimate.variants": "{count} distinct products to look for",
  "v2.estimate.cost": "up to ${cost}",
  "v2.estimate.calls": "up to {count} search calls",
  "v2.estimate.ceilingHint":
    "These are ceilings, not forecasts. Rows analysed before and products already in memory are reused automatically, so the real figures are usually well below.",
  "v2.estimate.time": "roughly {minutes} min",
  "v2.estimate.sheet": "sheet {sheet}",
  "v2.estimate.blocked": "Cannot start:",
  "v2.estimate.start": "Start",
  "v2.estimate.starting": "Starting…",
  "v2.estimate.cancel": "Use another file",
  "v2.estimate.markup": "Markup on the final quotation",
  "v2.estimate.rounds": "Retries on rows that find nothing convincing",
  "v2.estimate.roundsHint":
    "Each retry rewrites the query from what went wrong and searches again. Zero turns it off.",

  /* Passo 3: avanzamento -------------------------------------------------- */
  "v2.run.title": "Working on {file}",
  "v2.run.elapsed": "{minutes}:{seconds} elapsed",
  "v2.run.cancel": "Stop",
  "v2.run.cancelled": "Stopped. What was already found is kept.",
  "v2.run.reopen": "Reopen",
  "v2.run.leaveSafe":
    "You can close this page: the work carries on and you will find it here.",
  "v2.history.title": "Client history",
  "v2.history.empty": "No files or processing runs for this client yet.",
  "v2.history.refreshing": "Updating history…",
  "v2.history.back": "Back to client history",
  "v2.history.openResults": "Reopen results",
  "v2.history.file": "File",
  "v2.history.date": "Uploaded / processed",
  "v2.history.uploaded": "Uploaded",
  "v2.history.processed": "Processed",
  "v2.history.finished": "Finished {date}",
  "v2.history.work": "Available work",
  "v2.history.available": "{analyses} analyses · {jobs} jobs",
  "v2.history.kind.pipeline": "Pipeline",
  "v2.history.kind.job": "Historical job",
  "v2.history.kind.upload": "Uploaded file",
  "v2.history.rows": "Rows",
  "v2.history.status": "Status",
  "v2.history.coverage": "Coverage",
  "v2.history.coveragePipeline": "{covered}/{total} covered · {review} to review",
  "v2.history.coverageJob": "{processed}/{total} processed · {failed} failed",
  "v2.history.usage": "Usage",
  "v2.history.usageLine": "{calls} calls · {cached} cache hits",
  "v2.history.actions": "Actions",
  "v2.history.review": "to review",
  "v2.history.status.UPLOADED": "uploaded",
  "v2.history.status.QUEUED": "queued",
  "v2.history.status.RUNNING": "in progress",
  "v2.history.status.WAITING_ANSWERS": "waiting for answer",
  "v2.history.status.COMPLETED": "completed",
  "v2.history.status.COMPLETED_WITH_ERRORS": "completed with errors",
  "v2.history.status.FAILED": "failed",
  "v2.history.status.CANCELLED": "cancelled",

  "v2.results.wrongClient": "These results do not belong to the selected client.",
  "v2.results.title": "Results for {file}",
  "v2.results.subtitle": "{processed} of {total} rows processed",
  "v2.results.processed": "processed rows",
  "v2.results.withCandidates": "rows with candidates",
  "v2.results.coherent": "verified rows",
  "v2.results.failed": "failed rows",
  "v2.results.usage": "{calls} calls · {cached} cache hits",
  "v2.results.rows": "Rows and best candidates",
  "v2.results.noRows": "This job has no stored rows.",
  "v2.results.reused": "reused",
  "v2.results.query": "Search: {query}",
  "v2.results.noCandidates": "No candidate was stored for this row.",
  "v2.results.topCandidates": "Showing the best {shown} of {total} candidates",
  "v2.results.verdict.coherent": "coherent",
  "v2.results.verdict.incoherent": "incoherent",
  "v2.results.verdict.unsure": "to review",
  "v2.results.verdict.unchecked": "not verified",
  "v2.results.confidence": "{percent}% confidence",
  "v2.results.unavailable": "unavailable",
  "v2.results.promotion": "promotion",
  "v2.results.moq": "MOQ {count}",
  "v2.results.issues": "Verification: {issues}",
  "v2.results.matches": "Matches: {matches}",

  /* Le fasi, come le vede chi guarda -------------------------------------- */
  "v2.phase.QUEUED": "Getting ready",
  "v2.phase.ANALYSIS": "Understanding the rows",
  "v2.phase.QUESTIONS": "Questions",
  "v2.phase.REVIEW": "Confirming",
  "v2.phase.SEARCH": "Searching Taobao",
  "v2.phase.VERIFY": "Checking the results",
  "v2.phase.REFINE": "Retrying what failed",
  "v2.phase.REPORT": "Putting it together",

  /* Cosa sta facendo, adesso ---------------------------------------------- */
  "v2.step.queued": "Getting ready…",
  "v2.step.reading": "Reading the sheet…",
  "v2.step.analysing": "Reading every row and working out what it asks for…",
  "v2.step.analysingRows": "Understood {analysed} rows of {total}",
  "v2.step.questions": "{count} questions before going on",
  "v2.step.questionsOne": "1 question before going on",
  "v2.step.reanalysing": "Applying your answers to the rows that were stuck…",
  "v2.step.approving": "Confirming the rows: {done} of {total}",
  "v2.step.searchStarting": "Starting the search on Taobao…",
  "v2.step.searchRows": "Searching: {done} of {total} — {name}",
  "v2.step.verifying": "Checking that each product really matches the request…",
  "v2.step.refining": "Recovered {recovered} rows out of {redone} retried",
  "v2.step.refineRound": "Retry {round} of {total} on the rows that found nothing",
  "v2.step.report": "Putting the quotation together…",
  "v2.step.done": "Done",
  "v2.step.failed": "Stopped by an error",
  "v2.step.cancelled": "Stopped",

  /* Domande dell'IA -------------------------------------------------------- */
  "v2.ask.title": "A few things I could not work out",
  "v2.ask.hint":
    "Answering once is enough: the answer is stored and applies to every later sheet, so you will not be asked again.",
  "v2.ask.round": "round {round}",
  "v2.ask.affects": "affects {count} rows",
  "v2.ask.affectsOne": "affects 1 row",
  "v2.ask.example": "for example: {example}",
  "v2.ask.placeholder": "Your answer…",
  "v2.ask.skip": "I cannot say",
  "v2.ask.skipHint": "The rows stay flagged and you sort them out at the end.",
  "v2.ask.submit": "Answer and carry on",
  "v2.ask.submitting": "Carrying on…",
  "v2.ask.remaining": "{count} still to answer",

  /* Esito ------------------------------------------------------------------ */
  "v2.done.title": "Quotation ready",
  "v2.done.subtitle": "{confirmed} of {total} rows have a product that matches the request.",
  "v2.done.confirmed": "confirmed",
  "v2.done.uncertain": "to look at",
  "v2.done.uncovered": "nothing found",
  "v2.done.rejected": "found but rejected",
  "v2.done.notProcurable": "not sold online",
  "v2.done.reused": "from memory",
  "v2.done.spent": "spent ${cost} · {calls} search calls · {cached} saved by the cache",
  "v2.done.recovered": "{count} rows recovered by {rounds} retries",
  "v2.done.markup": "Markup",
  "v2.done.report": "Download the quotation",
  "v2.done.export": "Download the full results",
  "v2.done.details": "Open the detailed view",
  "v2.done.again": "Quote another file",

  "v2.review.title": "Technical review",
  "v2.review.hint":
    "These checks did not stop the pipeline and were not turned into questions. Review the affected rows before sending the quotation.",
  "v2.review.none": "No non-blocking technical issues were recorded.",
  "v2.review.category.INTERNAL": "Resolved internally",
  "v2.review.category.TAOBAO_CHECK": "Taobao check",
  "v2.review.category.ROW_REVIEW": "Row review",
  "v2.review.resolved": "handled automatically",
  "v2.review.attribute": "Attribute: {attribute}",
  "v2.review.code": "Technical code: {code}",
  "v2.gaps.title": "Rows that need you",
  "v2.gaps.hint":
    "Everything else is done. These are the rows where an automatic answer would have been a guess.",
  "v2.gaps.reason.no_results": "nothing found",
  "v2.gaps.reason.no_coherent": "found, but nothing convincing",
  "v2.gaps.reason.not_procurable": "not a marketplace item",
  "v2.gaps.reason.failed": "the search failed",
  "v2.gaps.reason.low_confidence": "the request is unclear",
  "v2.gaps.query": "searched for: {query}",
  "v2.gaps.none": "Nothing left over: every row has a product that matches.",

  "v2.error.title": "The run stopped",
  "v2.error.retry": "Try again",
} as const;

export type MessageKey = keyof typeof en;
