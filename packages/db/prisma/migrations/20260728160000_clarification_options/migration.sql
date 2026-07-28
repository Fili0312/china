-- Risposte pronte per le domande che sono una scelta, non un tema.
ALTER TABLE "TaobaoClarification" ADD COLUMN "options" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "TaobaoClarification" ADD COLUMN "answerMode" TEXT NOT NULL DEFAULT 'text';
