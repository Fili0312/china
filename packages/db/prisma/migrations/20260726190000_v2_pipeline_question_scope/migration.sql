-- Additive v2-only scoping. Existing clarification rows remain global and
-- retain exactly the semantics used by scouting-v1.
ALTER TABLE "TaobaoClarification"
  ADD COLUMN "clientId" TEXT,
  ADD COLUMN "pipelineId" TEXT,
  ADD COLUMN "datasetId" TEXT,
  ADD COLUMN "analysisRunId" TEXT,
  ADD COLUMN "locale" TEXT,
  ADD COLUMN "category" TEXT,
  ADD COLUMN "attributeKey" TEXT,
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "TaobaoPipeline"
  ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'it';

ALTER TABLE "TaobaoClarification"
  ADD CONSTRAINT "TaobaoClarification_pipelineId_fkey"
  FOREIGN KEY ("pipelineId") REFERENCES "TaobaoPipeline"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "TaobaoClarification_clientId_pipelineId_status_idx"
  ON "TaobaoClarification"("clientId", "pipelineId", "status");

CREATE INDEX "TaobaoClarification_pipelineId_questionKey_idx"
  ON "TaobaoClarification"("pipelineId", "questionKey");
