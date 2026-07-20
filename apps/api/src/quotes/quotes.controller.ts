import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Sse,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { CreateQuoteRequestSchema } from "@china/shared";
import { EventsService, SseMessage } from "./events.service";
import { QuotesService } from "./quotes.service";

@Controller("quotes")
export class QuotesController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly events: EventsService
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    // Validazione con gli schemi Zod condivisi (niente class-validator).
    const parsed = CreateQuoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.quotes.create(parsed.data);
  }

  @Get()
  list() {
    return this.quotes.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.quotes.get(id);
  }

  @Sse(":id/events")
  eventsStream(@Param("id") id: string): Observable<SseMessage> {
    return this.events.stream(id);
  }
}
