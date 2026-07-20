import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Ip,
  Query,
  Res,
} from "@nestjs/common";
import { ProductSearchQuerySchema } from "@china/shared";
import { SearchRateLimitService } from "./search-rate-limit.service";
import { SearchService } from "./search.service";

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

@Controller("search")
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly rateLimit: SearchRateLimitService
  ) {}

  @Get("health")
  health() {
    return this.search.health();
  }

  @Get()
  async run(
    @Query() query: unknown,
    @Ip() clientIp: string,
    @Res({ passthrough: true }) response: HeaderResponse
  ) {
    const parsed = ProductSearchQuerySchema.safeParse(query);
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
    return this.search.search(parsed.data);
  }
}
