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
async function rowsNeedingPerson(jobId: string): Promise<ReadonlySet<number>> {
  const pipeline = await prisma.taobaoPipeline.findFirst({
    where: { jobId },
    select: { outcome: true },
    orderBy: { createdAt: "desc" },
  });
  const parsed = TaobaoPipelineOutcomeSchema.safeParse(pipeline?.outcome);
  if (!parsed.success) return new Set<number>();
  return new Set(
    parsed.data.reviewIssues
      .filter((issue) => !issue.resolvedAutomatically)
      .map((issue) => issue.rowNumber)
  );
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
      buildV2TaobaoExport(results, { needsPerson: await rowsNeedingPerson(jobId) }),
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
        needsPerson: await rowsNeedingPerson(jobId),
      }),
      {
        disposition: contentDisposition(
          v2ReportFileName(results.job.clientName, results.job.fileName)
        ),
      }
    );
  }
}
