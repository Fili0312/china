-- Le query realmente inviate alla fonte, in ordine di tentativo.
ALTER TABLE "TaobaoJobRow" ADD COLUMN "attemptedQueries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
