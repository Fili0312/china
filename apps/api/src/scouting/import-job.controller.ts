import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  StreamableFile,
} from "@nestjs/common";
import {
  RetryJobRequestSchema,
  StartImportJobRequestSchema,
} from "@china/shared";
import {
  buildExportWorkbook,
  exportFileName,
} from "./export-workbook";
import { ImportJobService } from "./import-job.service";

/**
 * Comandi e letture di un job di importazione.
 *
 * L'avanzamento si legge con GET periodici invece che via SSE: la pagina
 * mostra decine di righe per decine di marketplace e un'istantanea completa
 * ogni paio di secondi è più semplice e più robusta di un flusso di eventi
 * incrementali da ricomporre nel browser.
 */
@Controller("scouting")
export class ImportJobController {
  constructor(private readonly jobs: ImportJobService) {}

  /** Avvia lo scouting di un file con i marketplace scelti. */
  @Post("datasets/:id/jobs")
  async start(@Param("id") datasetId: string, @Body() body: unknown) {
    const parsed = StartImportJobRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.jobs.createJob(datasetId, parsed.data);
  }

  @Get("jobs")
  list() {
    return this.jobs.listJobs();
  }

  /** Avanzamento per file, riga e marketplace. */
  @Get("jobs/:id")
  progress(@Param("id") jobId: string, @Query("rows") rows?: string) {
    const limit = Math.min(
      2000,
      Math.max(1, Number.parseInt(rows ?? "500", 10) || 500)
    );
    return this.jobs.progress(jobId, limit);
  }

  /** Prodotti trovati, riga per riga. */
  @Get("jobs/:id/results")
  results(
    @Param("id") jobId: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.jobs.results(jobId, {
      limit: Math.min(200, Math.max(1, Number.parseInt(limit ?? "50", 10) || 50)),
      offset: Math.max(0, Number.parseInt(offset ?? "0", 10) || 0),
    });
  }

  /** Scarica tutti i risultati in un unico Excel. */
  @Get("jobs/:id/export")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
  async export(@Param("id") jobId: string) {
    // Si esporta tutto: un export parziale sarebbe una trappola, perché il
    // file scaricato sembra completo.
    const results = await this.jobs.results(jobId, { limit: 5000, offset: 0 });
    const workbook = buildExportWorkbook(results);
    return new StreamableFile(workbook, {
      disposition: `attachment; filename="${exportFileName(results.job.fileName)}"`,
    });
  }

  @Post("jobs/:id/pause")
  pause(@Param("id") jobId: string) {
    return this.jobs.pause(jobId);
  }

  @Post("jobs/:id/resume")
  resume(@Param("id") jobId: string) {
    return this.jobs.resume(jobId);
  }

  @Post("jobs/:id/cancel")
  cancel(@Param("id") jobId: string) {
    return this.jobs.cancel(jobId);
  }

  /** Ritenta le righe fallite, o una sola fonte che si è sbloccata. */
  @Post("jobs/:id/retry")
  retry(@Param("id") jobId: string, @Body() body: unknown) {
    const parsed = RetryJobRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.jobs.retry(jobId, parsed.data);
  }
}
