-- La modalità della corsa: `v2` (comportamento storico) o `v3`.
-- Le corse già chiuse restano v2 per definizione: il default lo garantisce
-- senza toccare una riga.
ALTER TABLE "TaobaoPipeline" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'v2';
