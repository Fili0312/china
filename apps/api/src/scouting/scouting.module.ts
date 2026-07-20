import { Module } from "@nestjs/common";
import { SearchModule } from "../search/search.module";
import { ImportJobController } from "./import-job.controller";
import { ImportJobService } from "./import-job.service";
import { ScoutingController } from "./scouting.controller";
import { ScoutingRunnerService } from "./scouting-runner.service";
import { ScoutingService } from "./scouting.service";

@Module({
  imports: [SearchModule],
  controllers: [ScoutingController, ImportJobController],
  providers: [ScoutingService, ImportJobService, ScoutingRunnerService],
  exports: [ScoutingService, ImportJobService],
})
export class ScoutingModule {}
