"use client";

import Link from "next/link";
import { SearchExperience } from "../search-experience";

export default function ScrapingPage() {
  return (
    <SearchExperience
      title="Ricerca multi-motore sui marketplace cinesi"
      subtitle={
        <>
          Motori attivi: Taobao, Tmall, Alibaba, AliExpress, Made-in-China,
          Chinagoods e Yiwugo. La ricerca multi-motore normalizza la richiesta,
          verifica prodotto e specifiche, ordina per pertinenza e raggruppa i
          duplicati tra fonti. Prezzi e valuta restano quelli pubblicati;
          captcha ed errori sono isolati per fonte. Tmall è il catalogo storico
          disponibile nell'istanza OTAPI, non una ricerca live ufficiale. Con
          “Richieste da Excel” si importa un foglio 询价 e si cerca il testo
          cinese originale di ogni riga sui marketplace via browser. Da
          collegare con accesso autorizzato: 1688, JD, Pinduoduo, DHgate e
          Global Sources; non vengono simulati.{" "}
          <Link href="/">Torna alla home</Link>
        </>
      }
      placeholder="Cerca un prodotto… es. ceramic mug, powerbank, 保温杯"
      enableInquiry
    />
  );
}
