import { Module } from "@nestjs/common";
import { SearchModule } from "../search/search.module";
import { CandidateRefreshService } from "./candidate-refresh.service";
import { ImportJobController } from "./import-job.controller";
import { MarketplaceSessionController } from "./marketplace-session.controller";
import { MarketplaceSessionService } from "./marketplace-session.service";
import { ImportJobService } from "./import-job.service";
import { ScoutingController } from "./scouting.controller";
import { ScoutingRunnerService } from "./scouting-runner.service";
import { ScoutingService } from "./scouting.service";

@Module({
  imports: [SearchModule],
  controllers: [
    ScoutingController,
    ImportJobController,
    MarketplaceSessionController,
  ],
  providers: [
    ScoutingService,
    ImportJobService,
    ScoutingRunnerService,
    CandidateRefreshService,
    MarketplaceSessionService,
  ],
  exports: [ScoutingService, ImportJobService, MarketplaceSessionService],
})
export class ScoutingModule {}
