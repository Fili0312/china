import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
} from "@nestjs/common";
import {
  AnswerClarificationRequestSchema,
  ConnectTaobaoSessionRequestSchema,
  CreateClientRequestSchema,
  RerunTaobaoJobRequestSchema,
  SaveMappingRequestSchema,
  RefineTaobaoJobRequestSchema,
  StartTaobaoAnalysisRequestSchema,
  StartTaobaoJobRequestSchema,
  TaobaoUploadQuerySchema,
  UpdateAnalysisRowRequestSchema,
  UpdateClientRequestSchema,
  VerifyTaobaoJobRequestSchema,
  AnswerTaobaoPipelineRequestSchema,
  RetryV2RowsRequestSchema,
  StartTaobaoPipelineRequestSchema,
} from "@china/shared";
import { readBinaryBody, type BinaryRequest } from "../common/binary-body";
import { DatasetWorkbookError } from "../scouting/dataset-workbook";
import { ClarificationService } from "./clarification.service";
import { PipelineService } from "./pipeline.service";
import { ClientService } from "./client.service";
import { CoherenceService } from "./coherence.service";
import { RefineService } from "./refine.service";
import { buildTaobaoExport, exportFileName } from "./export-workbook";
import { buildClientReport, reportFileName } from "./report-workbook";
import { DataHubProvider } from "./providers/datahub.provider";
import { ElimApiProvider } from "./providers/elim.provider";
import { HwhProvider } from "./providers/hwh.provider";
import { TaobaoAnalysisService } from "./taobao-analysis.service";
import { TaobaoDatasetService } from "./taobao-dataset.service";
import { TaobaoJobService } from "./taobao-job.service";
import { TaobaoMemoryService } from "./taobao-memory.service";
import { TaobaoSessionService } from "./taobao-session.service";
import { t } from "../i18n/messages";

/**
 * L'API dello scouting v1.
 *
 * Una regola sola, visibile nella forma delle rotte: **tutto ciò che riguarda
 * un cliente sta sotto `/taobao/clients/:clientId/`**. Non esiste una rotta
 * che restituisca un file, un'analisi o una ricerca conoscendone solo l'id.
 * Non è una precauzione teorica: con id opachi ma condivisibili, una rotta
 * senza cliente è tutto ciò che serve perché il lavoro di un cliente finisca
 * sullo schermo di un altro.
 *
 * Fuori da quel prefisso restano solo le rotte che non contengono dati di
 * nessuno: lo stato dell'account Taobao e quello del trasporto API.
 */
function toHttpError(error: unknown): never {
  if (error instanceof DatasetWorkbookError) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: "TAOBAO_DATASET",
      message: error.message,
      availableSheets: error.availableSheets,
    });
  }
  throw error;
}

/** `Content-Disposition` con nome ASCII: gli header non accettano altro. */
function contentDisposition(fileName: string): string {
  return `attachment; filename="${fileName}"`;
}

@Controller("taobao")
export class TaobaoController {
  constructor(
    private readonly clients: ClientService,
    private readonly datasets: TaobaoDatasetService,
    private readonly analysis: TaobaoAnalysisService,
    private readonly sessions: TaobaoSessionService,
    private readonly jobs: TaobaoJobService,
    private readonly api: DataHubProvider,
    private readonly hwh: HwhProvider,
    private readonly elim: ElimApiProvider,
    private readonly clarifications: ClarificationService,
    private readonly pipeline: PipelineService,
    private readonly coherence: CoherenceService,
    private readonly refine: RefineService,
    private readonly memory: TaobaoMemoryService
  ) {}

  /* ---------------------------------------------------------------- */
  /* Stato dei servizi                                                 */
  /* ---------------------------------------------------------------- */

  /** Stato dell'analisi IA: chiave configurata (mai il valore), modello. */
  @Get("analysis/status")
  analysisStatus() {
    return this.analysis.status();
  }

  /** Stato del trasporto RapidAPI: configurazione, endpoint, consumo. */
  @Get("api/status")
  apiStatus() {
    return this.api.status();
  }

  /** Stato della ricerca primaria «Taobao API by H-W-H». */
  @Get("hwh/status")
  hwhStatus() {
    return this.hwh.status();
  }

  /** Stato del trasporto ElimAPI: configurazione, endpoint, consumo. */
  @Get("elim/status")
  elimStatus() {
    return this.elim.status();
  }

  /**
   * Richieste residue del piano ElimAPI.
   *
   * Chiamata separata perché costa un giro di rete: si chiede quando si vuole
   * saperlo, non a ogni caricamento di pagina.
   */
  @Get("elim/plan")
  elimPlan() {
    return this.elim.plan();
  }

  /* ---------------------------------------------------------------- */
  /* Memoria condivisa: storico varianti e domande di chiarimento      */
  /* ---------------------------------------------------------------- */

  /**
   * Lo storico della memoria interna: varianti già cercate e loro prodotti.
   *
   * Sta fuori dal prefisso cliente di proposito: contiene solo dati di
   * prodotto condivisi, mai per chi sono stati cercati.
   */
  @Get("memory")
  listMemory(@Query("query") query?: string, @Query("limit") limit?: string) {
    return this.memory.listRequests(
      query,
      Math.min(200, Math.max(1, Number.parseInt(limit ?? "30", 10) || 30))
    );
  }

  /** Le domande dell'IA, dalle più incontrate. `?status=OPEN` per le aperte. */
  @Get("clarifications")
  listClarifications(@Query("status") status?: string) {
    const filter =
      status === "OPEN" || status === "ANSWERED" || status === "DISMISSED"
        ? status
        : undefined;
    return this.clarifications.list(filter);
  }

  /** Risposta (o archiviazione) di una domanda: da qui diventa conoscenza. */
  @Patch("clarifications/:clarificationId")
  async answerClarification(
    @Param("clarificationId") clarificationId: string,
    @Body() body: unknown
  ) {
    const parsed = AnswerClarificationRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.clarifications.answer(clarificationId, parsed.data);
  }

  /* ---------------------------------------------------------------- */
  /* Account Taobao                                                    */
  /* ---------------------------------------------------------------- */

  @Get("session")
  session() {
    return this.sessions.status();
  }

  /** Collega la sessione: arrivano solo cookie, mai credenziali. */
  @Post("session")
  async connectSession(@Body() body: unknown) {
    const parsed = ConnectTaobaoSessionRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.sessions.connect(parsed.data);
  }

  @Delete("session")
  disconnectSession() {
    return this.sessions.disconnect();
  }

  /* ---------------------------------------------------------------- */
  /* Clienti                                                           */
  /* ---------------------------------------------------------------- */

  @Get("clients")
  listClients(@Query("includeArchived") includeArchived?: string) {
    return this.clients.list(includeArchived === "1" || includeArchived === "true");
  }

  @Post("clients")
  async createClient(@Body() body: unknown) {
    const parsed = CreateClientRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.clients.create(parsed.data);
  }

  @Get("clients/:clientId")
  getClient(@Param("clientId") clientId: string) {
    return this.clients.get(clientId);
  }

  @Patch("clients/:clientId")
  async updateClient(@Param("clientId") clientId: string, @Body() body: unknown) {
    const parsed = UpdateClientRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.clients.update(clientId, parsed.data);
  }

  /* ---------------------------------------------------------------- */
  /* File                                                              */
  /* ---------------------------------------------------------------- */

  @Get("clients/:clientId/datasets")
  listDatasets(@Param("clientId") clientId: string) {
    return this.datasets.list(clientId);
  }

  /** Carica un file per il cliente (corpo = file binario). */
  @Post("clients/:clientId/datasets")
  async upload(
    @Param("clientId") clientId: string,
    @Query() query: unknown,
    @Req() request: BinaryRequest
  ) {
    const parsed = TaobaoUploadQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const content = await readBinaryBody(request, this.datasets.maxUploadBytes);
    if (content.length === 0) throw new BadRequestException(t("err.noFile"));

    try {
      return await this.datasets.createDataset(
        clientId,
        content,
        parsed.data.fileName,
        parsed.data.sheet,
        parsed.data.previewLimit
      );
    } catch (error) {
      return toHttpError(error);
    }
  }

  @Get("clients/:clientId/datasets/:datasetId")
  dataset(
    @Param("clientId") clientId: string,
    @Param("datasetId") datasetId: string,
    @Query("previewLimit") limit?: string
  ) {
    const previewLimit = Math.min(
      200,
      Math.max(1, Number.parseInt(limit ?? "25", 10) || 25)
    );
    return this.datasets.getDataset(clientId, datasetId, previewLimit);
  }

  @Put("clients/:clientId/datasets/:datasetId/mapping")
  async saveMapping(
    @Param("clientId") clientId: string,
    @Param("datasetId") datasetId: string,
    @Body() body: unknown
  ) {
    const parsed = SaveMappingRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.datasets.saveMapping(clientId, datasetId, parsed.data.mapping);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- */
  /* Analisi e revisione                                               */
  /* ---------------------------------------------------------------- */

  @Post("clients/:clientId/datasets/:datasetId/analysis")
  async startAnalysis(
    @Param("clientId") clientId: string,
    @Param("datasetId") datasetId: string,
    @Body() body: unknown
  ) {
    const parsed = StartTaobaoAnalysisRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.analysis.startRun(clientId, datasetId, parsed.data);
  }

  @Get("clients/:clientId/datasets/:datasetId/analysis")
  listAnalysisRuns(
    @Param("clientId") clientId: string,
    @Param("datasetId") datasetId: string
  ) {
    return this.analysis.listRuns(clientId, datasetId);
  }

  @Get("clients/:clientId/analysis/:runId")
  getAnalysisRun(@Param("clientId") clientId: string, @Param("runId") runId: string) {
    return this.analysis.getRun(clientId, runId);
  }

  /** Correzione manuale di una riga della revisione. */
  @Patch("clients/:clientId/analysis/rows/:rowId")
  async updateAnalysisRow(
    @Param("clientId") clientId: string,
    @Param("rowId") rowId: string,
    @Body() body: unknown
  ) {
    const parsed = UpdateAnalysisRowRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.analysis.updateRow(clientId, rowId, parsed.data);
  }

  /* ---------------------------------------------------------------- */
  /* Ricerca                                                           */
  /* ---------------------------------------------------------------- */

  @Post("clients/:clientId/datasets/:datasetId/jobs")
  async startJob(
    @Param("clientId") clientId: string,
    @Param("datasetId") datasetId: string,
    @Body() body: unknown
  ) {
    const parsed = StartTaobaoJobRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.jobs.createJob(clientId, datasetId, parsed.data);
  }

  @Get("clients/:clientId/jobs")
  listJobs(@Param("clientId") clientId: string) {
    return this.jobs.listJobs(clientId);
  }

  @Get("clients/:clientId/jobs/:jobId")
  getJob(@Param("clientId") clientId: string, @Param("jobId") jobId: string) {
    return this.jobs.getJob(clientId, jobId);
  }

  @Get("clients/:clientId/jobs/:jobId/results")
  getResults(
    @Param("clientId") clientId: string,
    @Param("jobId") jobId: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.jobs.getResults(clientId, jobId, {
      limit: Math.min(1000, Math.max(1, Number.parseInt(limit ?? "500", 10) || 500)),
      offset: Math.max(0, Number.parseInt(offset ?? "0", 10) || 0),
    });
  }

  /** Storico dei cambiamenti di un prodotto: prezzo, vendite, disponibilità. */
  @Get("clients/:clientId/products/:productId/history")
  productHistory(
    @Param("clientId") clientId: string,
    @Param("productId") productId: string
  ) {
    return this.jobs.productHistory(clientId, productId);
  }

  /**
   * Riverifica un prodotto alla fonte, adesso, senza cache.
   *
   * È la risposta al prezzo che «cambia quando ci clicco»: il prezzo mostrato
   * è quello dell'ultimo controllo, questo lo riporta a oggi e aggiorna lo
   * storico se è cambiato.
   */
  @Post("clients/:clientId/products/:productId/refresh")
  refreshProduct(
    @Param("clientId") clientId: string,
    @Param("productId") productId: string
  ) {
    return this.jobs.refreshProduct(clientId, productId);
  }

  /**
   * Rilancia una ricerca già fatta, interrogando di nuovo la fonte.
   *
   * Crea un job nuovo che eredita la configurazione del precedente: lo storico
   * resta leggibile e i due risultati si possono confrontare.
   */
  @Post("clients/:clientId/jobs/:jobId/rerun")
  async rerunJob(
    @Param("clientId") clientId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown
  ) {
    const parsed = RerunTaobaoJobRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.jobs.rerunJob(clientId, jobId, parsed.data);
  }

  @Post("clients/:clientId/jobs/:jobId/cancel")
  cancelJob(@Param("clientId") clientId: string, @Param("jobId") jobId: string) {
    return this.jobs.cancel(clientId, jobId);
  }

  /**
   * Seconda passata IA: giudica se i candidati trovati sono coerenti con la
   * richiesta del foglio. I verdetti restano salvati sui risultati; i dubbi
   * che solo l'operatore può sciogliere diventano domande.
   */
  @Post("clients/:clientId/jobs/:jobId/verify")
  async verifyJob(
    @Param("clientId") clientId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown
  ) {
    const parsed = VerifyTaobaoJobRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.coherence.verifyJob(clientId, jobId, parsed.data);
  }

  /**
   * Ri-ricerca guidata dai difetti: per le righe senza un prodotto coerente,
   * l'IA riscrive la query dai motivi del fallimento, si cerca di nuovo e si
   * ri-verifica. Va lanciata dopo «Verifica coerenza».
   */
  @Post("clients/:clientId/jobs/:jobId/refine")
  async refineJob(
    @Param("clientId") clientId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown
  ) {
    const parsed = RefineTaobaoJobRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.refine.refineJob(clientId, jobId, parsed.data);
  }

  /** Scarica tutti i risultati in un solo Excel. */
  @Get("clients/:clientId/jobs/:jobId/export")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
  async export(@Param("clientId") clientId: string, @Param("jobId") jobId: string) {
    // Si esporta tutto: un export parziale sarebbe una trappola, perché il
    // file scaricato sembra completo.
    const results = await this.jobs.getResults(clientId, jobId, { limit: 1000, offset: 0 });
    return new StreamableFile(buildTaobaoExport(results), {
      disposition: contentDisposition(
        exportFileName(results.job.clientName, results.job.fileName)
      ),
    });
  }

  /**
   * Report per il cliente: quantità del foglio, 3 migliori link, prezzi già
   * ricaricati della percentuale scelta (`?markupPct=15`).
   */
  @Get("clients/:clientId/jobs/:jobId/report")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
  async report(
    @Param("clientId") clientId: string,
    @Param("jobId") jobId: string,
    @Query("markupPct") markup?: string
  ) {
    // Tra 0 e 500: un ricarico negativo o a quattro cifre è sempre un refuso,
    // e un refuso qui finisce dritto in un'offerta.
    const markupPct = Math.min(500, Math.max(0, Number.parseFloat(markup ?? "0") || 0));
    const results = await this.jobs.getResults(clientId, jobId, { limit: 1000, offset: 0 });
    return new StreamableFile(buildClientReport(results, { markupPct }), {
      disposition: contentDisposition(
        reportFileName(results.job.clientName, results.job.fileName)
      ),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Scouting v2: l'elaborazione che si guida da sola                     */
  /* ------------------------------------------------------------------ */

  /**
   * Cosa costerebbe elaborare questo foglio.
   *
   * Si chiama subito dopo il caricamento e prima di qualunque spesa: è
   * l'unico momento in cui fermarsi non costa nulla.
   */
  @Get("clients/:clientId/datasets/:datasetId/estimate")
  estimate(@Param("clientId") clientId: string, @Param("datasetId") datasetId: string) {
    return this.pipeline.estimate(clientId, datasetId);
  }

  /** Avvia l'elaborazione completa. Ritorna subito: si segue con lo stato. */
  @Post("clients/:clientId/datasets/:datasetId/pipeline")
  startPipeline(
    @Param("clientId") clientId: string,
    @Param("datasetId") datasetId: string,
    @Body() body: unknown
  ) {
    const parsed = StartTaobaoPipelineRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.pipeline.start(clientId, datasetId, parsed.data);
  }

  /** Ultime elaborazioni del cliente: per riprenderne una senza cercarla. */
  @Get("clients/:clientId/pipelines")
  listPipelines(@Param("clientId") clientId: string, @Query("limit") limit?: string) {
    return this.pipeline.list(clientId, Math.min(50, Number.parseInt(limit ?? "10", 10) || 10));
  }

  /**
   * A che punto è.
   *
   * È l'endpoint su cui la pagina fa polling: deve restare economico, e per
   * questo non ricalcola nulla — legge lo stato che il servizio ha già scritto.
   */
  @Get("clients/:clientId/pipelines/:pipelineId")
  pipelineState(
    @Param("clientId") clientId: string,
    @Param("pipelineId") pipelineId: string
  ) {
    return this.pipeline.state(clientId, pipelineId);
  }

  /** Risponde alle domande dell'IA e fa ripartire l'elaborazione. */
  @Post("clients/:clientId/pipelines/:pipelineId/answers")
  answerPipeline(
    @Param("clientId") clientId: string,
    @Param("pipelineId") pipelineId: string,
    @Body() body: unknown
  ) {
    const parsed = AnswerTaobaoPipelineRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.pipeline.answer(clientId, pipelineId, parsed.data);
  }

  @Post("clients/:clientId/pipelines/:pipelineId/cancel")
  cancelPipeline(
    @Param("clientId") clientId: string,
    @Param("pipelineId") pipelineId: string
  ) {
    return this.pipeline.cancel(clientId, pipelineId);
  }

  /**
   * Quanto costerebbe riprovare queste righe.
   *
   * È un POST anche se non cambia niente: l'elenco delle righe è lungo e in
   * una query string finirebbe troncato dal primo proxy che incontra.
   */
  @Post("clients/:clientId/pipelines/:pipelineId/retry-estimate")
  estimatePipelineRetry(
    @Param("clientId") clientId: string,
    @Param("pipelineId") pipelineId: string,
    @Body() body: unknown
  ) {
    const parsed = RetryV2RowsRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.pipeline.estimateRetry(clientId, pipelineId, parsed.data);
  }

  /** Riprova le righe scelte al gradino scelto. */
  @Post("clients/:clientId/pipelines/:pipelineId/retry")
  retryPipelineRows(
    @Param("clientId") clientId: string,
    @Param("pipelineId") pipelineId: string,
    @Body() body: unknown
  ) {
    const parsed = RetryV2RowsRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.pipeline.retryRows(clientId, pipelineId, parsed.data);
  }
}
