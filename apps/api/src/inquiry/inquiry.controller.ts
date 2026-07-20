import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  InquiryImportQuerySchema,
  InquiryRowsQuerySchema,
} from "@china/shared";
import { readBinaryBody, type BinaryRequest } from "../common/binary-body";
import { InquiryService } from "./inquiry.service";
import { InquiryWorkbookError } from "./inquiry-workbook";

function toHttpError(error: unknown): never {
  if (error instanceof InquiryWorkbookError) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: "INQUIRY_WORKBOOK",
      message: error.message,
      availableSheets: error.availableSheets,
    });
  }
  throw error;
}

@Controller("inquiry")
export class InquiryController {
  constructor(private readonly inquiry: InquiryService) {}

  /** Fogli di richiesta disponibili sul server. */
  @Get("sources")
  sources() {
    return this.inquiry.listSources();
  }

  /** Righe e query cinesi di un foglio già presente sul server. */
  @Get("rows")
  async rows(@Query() query: unknown) {
    const parsed = InquiryRowsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    try {
      return await this.inquiry.readSource(parsed.data.source, parsed.data.sheet);
    } catch (error) {
      return toHttpError(error);
    }
  }

  /** Importa un foglio caricato dall'interfaccia (corpo = file binario). */
  @Post("import")
  async import(@Query() query: unknown, @Req() request: BinaryRequest) {
    const parsed = InquiryImportQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const content = await readBinaryBody(request, this.inquiry.maxUploadBytes);
    if (content.length === 0) {
      throw new BadRequestException("Nessun file ricevuto.");
    }
    try {
      return this.inquiry.parse(
        content,
        parsed.data.fileName,
        parsed.data.sheet
      );
    } catch (error) {
      return toHttpError(error);
    }
  }
}
