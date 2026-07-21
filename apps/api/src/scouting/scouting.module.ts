import { Module } from "@nestjs/common";
import { SearchModule } from "../search/search.module";
import { AnalysisController } from "../analysis/analysis.controller";
import { ClaudeProductAnalysisService } from "../analysis/claude-product-analysis.service";
import { RequestAnalysisService } from "../analysis/request-analysis.service";
import { CandidateRefreshService } from "./candidate-refresh.service";
import { ImportJobController } from "./import-job.controller";
import { KnownProductService } from "./known-product.service";
import { MarketplaceSessionController } from "./marketplace-session.controller";
import { MarketplaceSessionService } from "./marketplace-session.service";
import { ImportJobService } from "./import-job.service";
import { ScoutingController } from "./scouting.controller";
import { ScoutingRunnerService } from "./scouting-runner.service";
import { ScoutingService } from "./scouting.service";

/**
 * Analisi e scouting stanno nello stesso modulo di proposito.
 *
 * Sono due fasi dello stesso flusso e si usano a vicenda: l'analisi legge il
 * dataset, il job legge l'analisi. Separarli in due moduli Nest darebbe una
 * dipendenza circolare in cambio di nessun isolamento reale — l'isolamento che
 * conta, quello di Claude, è nel confine del codice (`analysis/`), non nel
 * grafo dei moduli.
 */
@Module({
  imports: [SearchModule],
  controllers: [
    ScoutingController,
    ImportJobController,
    AnalysisController,
    MarketplaceSessionController,
  ],
  providers: [
    ScoutingService,
    ImportJobService,
    ScoutingRunnerService,
    CandidateRefreshService,
    KnownProductService,
    ClaudeProductAnalysisService,
    RequestAnalysisService,
    MarketplaceSessionService,
  ],
  exports: [
    ScoutingService,
    ImportJobService,
    RequestAnalysisService,
    MarketplaceSessionService,
  ],
})
export class ScoutingModule {}
