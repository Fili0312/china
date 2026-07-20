import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Ip,
  Post,
  Res,
} from "@nestjs/common";
import { AggregateSearchRequestSchema } from "@china/shared";
import { SearchRateLimitService } from "./search-rate-limit.service";
import { SearchService } from "./search.service";

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

/** Endpoint pubblico versionato per una ricerca coordinata e deduplicata. */
@Controller("v1/searches")
export class AggregateSearchController {
  constructor(
    private readonly search: SearchService,
    private readonly rateLimit: SearchRateLimitService
  ) {}

  @Post()
  async run(
    @Body() body: unknown,
    @Ip() clientIp: string,
    @Res({ passthrough: true }) response: HeaderResponse
  ) {
    const parsed = AggregateSearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const decision = await this.rateLimit.consume(clientIp || "direct");
    if (!decision.allowed) {
      response.setHeader("Retry-After", String(decision.retryAfterSeconds));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: "SEARCH_RATE_LIMIT",
          message: "Limite di ricerca raggiunto; riprova fra meno di un minuto.",
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    return this.search.searchMany(parsed.data);
  }
}
