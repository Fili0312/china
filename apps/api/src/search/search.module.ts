import { Module } from "@nestjs/common";
import { AggregateSearchController } from "./aggregate-search.controller";
import { SearchController } from "./search.controller";
import { SearchRateLimitService } from "./search-rate-limit.service";
import { SearchService } from "./search.service";

@Module({
  controllers: [SearchController, AggregateSearchController],
  providers: [SearchService, SearchRateLimitService],
  // Lo scouting riusa il motore di ricerca già registrato: un solo Chromium,
  // una sola cache e un solo cooldown anti-captcha per processo.
  exports: [SearchService],
})
export class SearchModule {}
