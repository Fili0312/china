// Gira sul compilato: tsx non emette `design:paramtypes`, quindi con i
// sorgenti Nest inietta undefined in tutte le dipendenze del costruttore.
const { NestFactory } = require("@nestjs/core");
const { prisma } = require("@china/db");
const { AppModule } = require("/var/www/china/apps/api/dist/app.module");
const { PipelineService } = require("/var/www/china/apps/api/dist/taobao/pipeline.service");

const PIPELINE = process.env.REJUDGE_PIPELINE || "cms4jag2q00dv7st7jaeyxgas";

(async () => {
  const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({ where: { id: PIPELINE } });
  const before = pipeline.outcome || {};
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const after = await app.get(PipelineService, { strict: false }).recomputeOutcome(PIPELINE);
  await app.close();
  const line = (l, a, b) =>
    console.log(l.padEnd(15) + String(a ?? "?").padStart(5) + String(b).padStart(8));
  console.log("               prima    dopo");
  line("confermati", before.confirmedRows, after.confirmedRows);
  line("da confermare", before.uncertainRows, after.uncertainRows);
  line("non trovati", before.uncoveredRows, after.uncoveredRows);
  await prisma.$disconnect();
})();
