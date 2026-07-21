import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  StartAnalysisRequestSchema,
  UpdateAnalysisRowRequestSchema,
} from "@china/shared";
import { ClaudeProductAnalysisService } from "./claude-product-analysis.service";
import { RequestAnalysisService } from "./request-analysis.service";

/**
 * La fase «Analisi richieste con IA», vista dall'esterno.
 *
 * Il controller non conosce Claude: chiama `RequestAnalysisService` e basta.
 * Nessuna risposta di questo controller contiene la chiave API, il prompt o
 * altro che riguardi il modello oltre al suo nome e alla versione del prompt —
 * che servono a spiegare **con cosa** è stata fatta un'analisi salvata.
 */
@Controller("scouting")
export class AnalysisController {
  constructor(
    private readonly analysis: RequestAnalysisService,
    private readonly claude: ClaudeProductAnalysisService
  ) {}

  /**
   * Stato del servizio di analisi.
   *
   * Espone se una chiave è configurata, mai il suo valore: serve
   * all'interfaccia per dire «manca la chiave» invece di far fallire l'analisi
   * dopo che l'utente ha caricato un file.
   */
  @Get("analysis/status")
  status() {
    return {
      configured: this.claude.isConfigured,
      model: this.claude.model,
      promptVersion: this.claude.promptVersion,
      minConfidence: this.analysis.minConfidence,
    };
  }

  /** Avvia l'analisi di un file e apre la sessione di revisione. */
  @Post("datasets/:id/analysis")
  async start(@Param("id") datasetId: string, @Body() body: unknown) {
    const parsed = StartAnalysisRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.analysis.startRun(datasetId, parsed.data);
  }

  /** Sessioni di analisi già fatte su questo file. */
  @Get("datasets/:id/analysis")
  list(@Param("id") datasetId: string, @Query("limit") limit?: string) {
    const take = Math.min(50, Math.max(1, Number.parseInt(limit ?? "10", 10) || 10));
    return this.analysis.listRuns(datasetId, take);
  }

  /** Sessione completa: righe, identità, stato nel database, consumo. */
  @Get("analysis/:runId")
  run(@Param("runId") runId: string) {
    return this.analysis.getRun(runId);
  }

  /** Correzione manuale di una riga prima di avviare lo scouting. */
  @Patch("analysis/rows/:rowId")
  async updateRow(@Param("rowId") rowId: string, @Body() body: unknown) {
    const parsed = UpdateAnalysisRowRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.analysis.updateRow(rowId, parsed.data);
  }
}
