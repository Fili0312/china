import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  DatasetUploadQuerySchema,
  NormalizePreviewRequestSchema,
  SaveMappingRequestSchema,
} from "@china/shared";
import { readBinaryBody, type BinaryRequest } from "../common/binary-body";
import { ALL_SHEETS, DatasetWorkbookError } from "./dataset-workbook";
import { ScoutingService } from "./scouting.service";

/** Traduce gli errori di lettura file in risposte con causa leggibile. */
function toHttpError(error: unknown): never {
  if (error instanceof DatasetWorkbookError) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: "SCOUTING_DATASET",
      message: error.message,
      availableSheets: error.availableSheets,
    });
  }
  throw error;
}

@Controller("scouting")
export class ScoutingController {
  constructor(private readonly scouting: ScoutingService) {}

  /** Dataset caricati, dal più recente. */
  @Get("datasets")
  listDatasets() {
    return this.scouting.listDatasets();
  }

  /**
   * Carica un file di richieste (corpo = file binario).
   * Formati accettati: .xlsx, .xls, .xlsm, .csv
   */
  @Post("datasets")
  async upload(@Query() query: unknown, @Req() request: BinaryRequest) {
    const parsed = DatasetUploadQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const content = await readBinaryBody(request, this.scouting.maxUploadBytes);
    if (content.length === 0) {
      throw new BadRequestException("Nessun file ricevuto.");
    }
    try {
      return await this.scouting.createDataset(
        content,
        parsed.data.fileName,
        // Senza un foglio indicato si leggono **tutti**: nei fogli di
        // richiesta reali le righe sono divise per reparto, e importarne uno
        // solo lascia fuori la maggior parte del lavoro senza dirlo.
        parsed.data.sheet ?? ALL_SHEETS,
        parsed.data.previewLimit
      );
    } catch (error) {
      return toHttpError(error);
    }
  }

  /** Anteprima di un dataset già caricato. */
  @Get("datasets/:id")
  async dataset(@Param("id") id: string, @Query("previewLimit") limit?: string) {
    const previewLimit = Math.min(
      200,
      Math.max(1, Number.parseInt(limit ?? "25", 10) || 25)
    );
    return this.scouting.getDataset(id, previewLimit);
  }

  /** Conferma la mappatura colonna → campo. */
  @Put("datasets/:id/mapping")
  async saveMapping(@Param("id") id: string, @Body() body: unknown) {
    const parsed = SaveMappingRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    await this.scouting.saveMapping(id, parsed.data.mapping);
    return { ok: true };
  }

  /**
   * Normalizza le righe con la mappatura indicata e segnala quali richieste
   * sono già state elaborate in passato. Non scrive nulla: serve a far
   * verificare la mappatura prima di avviare lo scouting.
   */
  @Post("datasets/:id/normalize")
  async normalize(@Param("id") id: string, @Body() body: unknown) {
    const parsed = NormalizePreviewRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.scouting.normalizePreview(
      id,
      parsed.data.mapping,
      parsed.data.limit
    );
  }
}
