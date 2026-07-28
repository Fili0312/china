/**
 * I due casi che il giudice sbagliava: li riconosce ora?
 *
 * Entrambi hanno la stessa firma — l'inserzione **dichiara** un valore
 * diverso da quello richiesto, e il modello lo descriveva a parole per poi
 * votare «non dichiarato». Sono scritti a mano perché sono il controllo,
 * non il campione: servono a dire se la correzione ha morso, non a misurare.
 */
import { verifyCandidateCoherence } from "@china/ai";

const CASI = [
  {
    nome: "nastro: 50 metri dove ne servono 10",
    request: [
      "Prodotto richiesto: nastro biadesivo 3M",
      "Misure: larghezza 10mm, lunghezza 10m",
      "Query usata: 3M双面胶 10毫米 10米",
    ].join("\n"),
    candidato:
      "Titolo: 新款 皇冠特价-3M双面胶带(3M正品)宽10毫米*长50米 厚度0.15MM\nMarketplace: taobao",
    atteso: "incoherent",
  },
  {
    nome: "tester: strumento di un'altra famiglia",
    request: [
      "Prodotto richiesto: tester elettrostatico",
      "Modello: JH-TEST",
      "Specifiche: 22kV; errore 5%; batteria ricaricabile",
      "Query usata: 静电测试仪 JH-TEST 22kV",
    ].join("\n"),
    candidato:
      "Titolo: simco静电测试仪器离子风机红外线检测量物体表面摩擦高电压\nMarketplace: taobao",
    atteso: "incoherent",
  },
  {
    nome: "controllo positivo: spessore richiesto presente nell'elenco",
    request: [
      "Prodotto richiesto: guarnizione in silicone bianca",
      "Misure: spessore 3mm",
      "Query usata: 白硅胶垫片 3mm",
    ].join("\n"),
    candidato:
      "Titolo: 硅胶板厚1/2/3/5/10/20mm白色垫块垫片防滑减震皮耐高温硅胶垫软\nMarketplace: taobao",
    atteso: "non-incoherent",
  },
];

async function main() {
  const result = await verifyCandidateCoherence(
    CASI.map((caso, index) => ({
      rowIndex: index,
      request: caso.request,
      candidates: [{ candidateIndex: 0, description: caso.candidato }],
    })),
    { timeoutMs: 120_000 }
  );

  let ok = 0;
  for (const [index, caso] of CASI.entries()) {
    const verdict = result.verdicts.get(`${index}:0`);
    const passed =
      caso.atteso === "incoherent"
        ? verdict?.verdict === "incoherent"
        : verdict?.verdict !== "incoherent";
    if (passed) ok += 1;
    console.log(`${passed ? "OK  " : "KO  "} ${caso.nome}`);
    console.log(`     verdetto: ${verdict?.verdict} — ${verdict?.issues?.[0] ?? ""}`);
  }
  console.log(`\n${ok}/${CASI.length} · costo $${result.costUsd.toFixed(5)}`);
}

void main();
