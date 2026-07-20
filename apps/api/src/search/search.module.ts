import { Module } from "@nestjs/common";
import { AggregateSearchController } from "./aggregate-search.controller";
import { SearchController } from "./search.controller";
import { SearchRateLimitService } from "./search-rate-limit.service";
import { SearchService } from "./search.service";

@Module({
  controllers: [SearchController, AggregateSearchController],
  providers: [SearchService, SearchRateLimitService],
})
export class SearchModule {}
