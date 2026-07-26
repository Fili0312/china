import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  StreamableFile,
} from "@nestjs/common";
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
    return new StreamableFile(buildV2TaobaoExport(results), {
      disposition: contentDisposition(
        v2ExportFileName(results.job.clientName, results.job.fileName)
      ),
    });
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
      buildV2ClientReport(results, { markupPct }),
      {
        disposition: contentDisposition(
          v2ReportFileName(results.job.clientName, results.job.fileName)
        ),
      }
    );
  }
}
