import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  StreamableFile,
} from "@nestjs/common";
import { prisma } from "@china/db";
import { TaobaoPipelineOutcomeSchema } from "@china/shared";
import { TaobaoJobService } from "./taobao-job.service";
import {
  buildV2ClientReport,
  buildV2TaobaoExport,
  v2ExportFileName,
  v2ReportFileName,
  type V2ReviewStatus,
  type V2WorkbookOptions,
} from "./v2-workbooks";

function contentDisposition(fileName: string): string {
  return `attachment; filename="${fileName}"`;
}

/**
 * Le righe che, nell'esito della corsa, aspettano ancora una persona.
 *
 * Il file scaricato e la schermata devono raccontare la stessa cosa: una riga
 * che in pagina chiede una decisione non può arrivare al cliente marcata come
 * «prodotto corretto». L'informazione vive nell'esito della pipeline, quindi
 * si va a prenderla lì. Se il job non appartiene a una pipeline v2 — o
 * l'esito non c'è ancora — l'insieme è vuoto e il file resta come prima.
 */
async function outcomeContext(jobId: string): Promise<V2WorkbookOptions> {
  const pipeline = await prisma.taobaoPipeline.findFirst({
    where: { jobId },
    select: { outcome: true },
    orderBy: { createdAt: "desc" },
  });
  const parsed = TaobaoPipelineOutcomeSchema.safeParse(pipeline?.outcome);
  if (!parsed.success) return {};

  const outcome = parsed.data;
  const needsPerson = new Set(
    outcome.reviewIssues
      .filter((issue) => !issue.resolvedAutomatically)
      .map((issue) => issue.rowNumber)
  );
  const notProcurable = new Set(
    outcome.gaps
      .filter((gap) => gap.reason === "not_procurable")
      .map((gap) => gap.rowNumber)
  );

  // Lo stato riga per riga, dedotto una volta sola dall'esito. Le priorità
  // sono le stesse della pagina: prima ciò che non si compra, poi ciò che è
  // stato respinto, poi ciò che è rimasto vuoto, poi ciò che aspetta una
  // persona. Tutto il resto è pronto.
  const statusByRow = new Map<number, V2ReviewStatus>();
  for (const gap of outcome.gaps) {
    statusByRow.set(
      gap.rowNumber,
      gap.reason === "not_procurable"
        ? "not_procurable"
        : gap.reason === "no_coherent"
          ? "rejected"
          : "none"
    );
  }
  for (const rowNumber of needsPerson) {
    if (!statusByRow.has(rowNumber)) statusByRow.set(rowNumber, "check");
  }

  return { statusByRow, needsPerson, notProcurable };
}

/**
 * Download esclusivi di `/china/scouting-v2`.
 *
 * Le rotte e i generatori storici restano byte-per-byte separati: la v1 non
 * riceve nuove colonne né cambia il proprio formato.
 */
@Controller("taobao")
export class V2ExportController {
  constructor(private readonly jobs: TaobaoJobService) {}

  @Get("clients/:clientId/jobs/:jobId/v2-export")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
  async export(
    @Param("clientId") clientId: string,
    @Param("jobId") jobId: string
  ) {
    const results = await this.jobs.getResults(clientId, jobId, {
      limit: 1000,
      offset: 0,
    });
    return new StreamableFile(
      buildV2TaobaoExport(results, await outcomeContext(jobId)),
      {
        disposition: contentDisposition(
          v2ExportFileName(results.job.clientName, results.job.fileName)
        ),
      }
    );
  }

  @Get("clients/:clientId/jobs/:jobId/v2-report")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
  async report(
    @Param("clientId") clientId: string,
    @Param("jobId") jobId: string,
    @Query("markupPct") markup?: string
  ) {
    const markupPct = Math.min(
      500,
      Math.max(0, Number.parseFloat(markup ?? "0") || 0)
    );
    const results = await this.jobs.getResults(clientId, jobId, {
      limit: 1000,
      offset: 0,
    });
    return new StreamableFile(
      buildV2ClientReport(results, {
        markupPct,
        ...(await outcomeContext(jobId)),
      }),
      {
        disposition: contentDisposition(
          v2ReportFileName(results.job.clientName, results.job.fileName)
        ),
      }
    );
  }
}
