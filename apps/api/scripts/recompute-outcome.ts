/**
 * Rifà il conto finale di una corsa già chiusa, senza rieseguirla.
 *
 * I verdetti dei candidati possono cambiare sotto una corsa conclusa — un
 * rigiudizio dopo una modifica alle regole, il ritentativo di una riga. Le
 * caselle in alto nella pagina leggono l'`outcome` congelato a fine corsa,
 * i gruppi del report si ricalcolano dai candidati: senza questo passaggio
 * i due numeri si contraddicono.
 */
import { NestFactory } from "@nestjs/core";
import { prisma } from "@china/db";
import { AppModule } from "../src/app.module";
import { PipelineService } from "../src/taobao/pipeline.service";

const PIPELINE = process.env.REJUDGE_PIPELINE ?? "cms4jag2q00dv7st7jaeyxgas";

async function main() {
  const pipeline = await prisma.taobaoPipeline.findUniqueOrThrow({ where: { id: PIPELINE } });
  const before = pipeline.outcome as {
    confirmedRows?: number;
    uncertainRows?: number;
    uncoveredRows?: number;
  } | null;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  // `strict: false`: PipelineService vive in TaobaoModule, non nel modulo
  // radice. Senza questo Nest ne restituisce uno senza dipendenze iniettate.
  const after = await app.get(PipelineService, { strict: false }).recomputeOutcome(PIPELINE);
  await app.close();

  const line = (label: string, a: unknown, b: number) =>
    console.log(`${label.padEnd(14)}${String(a ?? "?").padStart(5)}  ${String(b).padStart(5)}`);

  console.log("              prima   dopo");
  line("confermati", before?.confirmedRows, after.confirmedRows);
  line("da confermare", before?.uncertainRows, after.uncertainRows);
  line("non trovati", before?.uncoveredRows, after.uncoveredRows);

  await prisma.$disconnect();
}

void main();
