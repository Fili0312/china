import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import { MarketplaceSessionService } from "./marketplace-session.service";

/**
 * Collegamento manuale degli account 1688 e Taobao.
 *
 * Nessuna risposta di questo controller contiene i cookie: si può collegare,
 * vedere lo stato e scollegare, mai rileggere ciò che è stato salvato. Se
 * servisse rivederli, la risposta giusta è ricollegare l'account.
 */
const ConnectSchema = z.object({
  /** Cookie esportati dal browser, in JSON. */
  cookies: z.string().min(2).max(200_000),
  label: z.string().trim().max(80).nullable().default(null),
});

@Controller("scouting/sessions")
export class MarketplaceSessionController {
  constructor(private readonly sessions: MarketplaceSessionService) {}

  @Get()
  list() {
    return this.sessions.list();
  }

  @Get(":marketplace")
  status(@Param("marketplace") marketplace: string) {
    return this.sessions.status(marketplace);
  }

  @Post(":marketplace")
  connect(@Param("marketplace") marketplace: string, @Body() body: unknown) {
    const parsed = ConnectSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.sessions.connect(
      marketplace,
      parsed.data.cookies,
      parsed.data.label
    );
  }

  @Delete(":marketplace")
  async disconnect(@Param("marketplace") marketplace: string) {
    await this.sessions.disconnect(marketplace);
    return { ok: true };
  }
}
