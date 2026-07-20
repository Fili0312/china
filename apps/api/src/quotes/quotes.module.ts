import { Module } from "@nestjs/common";
import { EventsService } from "./events.service";
import { QuotesController } from "./quotes.controller";
import { QuotesService } from "./quotes.service";

@Module({
  controllers: [QuotesController],
  providers: [QuotesService, EventsService],
})
export class QuotesModule {}
