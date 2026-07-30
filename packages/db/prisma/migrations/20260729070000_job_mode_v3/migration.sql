-- Il runner deve sapere in che modalità sta lavorando senza risalire alla
-- pipeline. I job esistenti sono v2 per definizione.
ALTER TABLE "TaobaoJob" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'v2';
