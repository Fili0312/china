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
import { InquiryService } from "./inquiry.service";
import { InquiryWorkbookError } from "./inquiry-workbook";

/**
 * Il corpo della richiesta arriva come stream binario: i parser JSON e
 * urlencoded di Nest ignorano `application/octet-stream`, quindi lo stream è
 * ancora leggibile qui e non serve un parser multipart aggiuntivo.
 */
interface BinaryRequest {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  destroy(error?: Error): void;
}

function readBody(request: BinaryRequest, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy();
        rejectPromise(
          new HttpException(
            `File troppo grande: il limite è ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
            HttpStatus.PAYLOAD_TOO_LARGE
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks)));
    request.on("error", (error) => rejectPromise(error));
  });
}

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
    const content = await readBody(request, this.inquiry.maxUploadBytes);
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
