import { Module } from "@nestjs/common";
import { ClaudeProductAnalysisService } from "../analysis/claude-product-analysis.service";
import { ClarificationService } from "./clarification.service";
import { PipelineService } from "./pipeline.service";
import { ClientService } from "./client.service";
import { CoherenceService } from "./coherence.service";
import { RefineService } from "./refine.service";
import { DataHubClient } from "./providers/datahub.client";
import { DataHubProvider } from "./providers/datahub.provider";
import { ElimApiClient } from "./providers/elim.client";
import { ElimApiProvider } from "./providers/elim.provider";
import { HwhProvider } from "./providers/hwh.provider";
import { TaobaoBrowserService } from "./providers/browser-search.service";
import { TaobaoAnalysisService } from "./taobao-analysis.service";
import { TaobaoController } from "./taobao.controller";
import { TaobaoDatasetService } from "./taobao-dataset.service";
import { TaobaoJobService } from "./taobao-job.service";
import { TaobaoMemoryService } from "./taobao-memory.service";
import { TaobaoRunnerService } from "./taobao-runner.service";
import { TaobaoSessionService } from "./taobao-session.service";
import { V2ExportController } from "./v2-export.controller";

/**
 * Lo scouting v1: un cliente, un file, solo Taobao.
 *
 * Modulo **separato** da `ScoutingModule`, e non un suo ramo. Condivide con lo
 * scouting classico solo ciò che ha senso condividere — la lettura dei fogli
 * Excel, il servizio Claude con la sua cache, la crittografia delle sessioni —
 * e tiene per sé identità, memoria dei prodotti, trasporti e interfaccia.
 *
 * Il motivo è pratico: `/scouting` continua a funzionare esattamente com'era,
 * e una modifica qui non può romperlo. Il prezzo è qualche riga di
 * orchestrazione ripetuta; il beneficio è che le due pagine possono divergere
 * senza negoziare.
 */
@Module({
  controllers: [TaobaoController, V2ExportController],
  providers: [
    ClientService,
    TaobaoDatasetService,
    TaobaoAnalysisService,
    TaobaoMemoryService,
    TaobaoSessionService,
    TaobaoJobService,
    TaobaoRunnerService,
    TaobaoBrowserService,
    DataHubClient,
    DataHubProvider,
    // Ricerca primaria «Taobao API by H-W-H»: DataHub resta il fallback.
    HwhProvider,
    // Seconda fonte: interviene quando la prima non basta.
    ElimApiClient,
    ElimApiProvider,
    // Lo stesso servizio usato da `/scouting`: stesso prompt, stessa cache,
    // stesso conteggio dei costi. Analizzare qui un file già analizzato là
    // non costa una seconda chiamata.
    ClaudeProductAnalysisService,
    // Domande di chiarimento e seconda passata di coerenza.
    ClarificationService,
    CoherenceService,
    // Ri-ricerca guidata dai difetti (Approccio A).
    RefineService,
    // Scouting v2: concatena i servizi qui sopra e decide da sé cosa fare
    // dopo. Non aggiunge logica di dominio, solo l'ordine dei passi.
    PipelineService,
  ],
})
export class TaobaoModule {}
