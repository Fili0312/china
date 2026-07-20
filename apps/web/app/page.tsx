"use client";

import Link from "next/link";
import { SearchExperience } from "./search-experience";

export default function HomePage() {
  return (
    <SearchExperience
      title="Ricerca prodotti dalla Cina"
      subtitle={
        <>
          Cerca insieme su Taobao, Tmall, Alibaba, AliExpress, Made-in-China,
          Chinagoods e Yiwugo, oppure scegli una singola fonte. I risultati
          vengono verificati per pertinenza e specifiche, quindi deduplicati e
          ordinati prima di essere mostrati.{" "}
          <Link href="/scraping">Apri la pagina multi-motore estesa</Link>
        </>
      }
      placeholder="Cerca un prodotto… es. powerbank, ceramic mug, 保温杯"
    />
  );
}
