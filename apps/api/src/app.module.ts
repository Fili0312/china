import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { LocaleMiddleware } from "./i18n/locale.middleware";
import { TaobaoModule } from "./taobao/taobao.module";

/**
 * L'API serve una sola interfaccia: lo scouting Taobao per cliente.
 *
 * `QuotesModule`, `SearchModule`, `InquiryModule` e `ScoutingModule` non sono
 * più registrati. Le pagine che li chiamavano — ricerca diretta OTAPI, ricerca
 * multi-motore, scouting multi-marketplace, preventivi Playwright — sono state
 * rimosse, e tenere in linea endpoint che nessuno chiama significa tenere vive
 * le loro chiavi, i loro costi e la loro superficie esposta.
 *
 * Il codice resta sul disco (`src/quotes`, `src/search`, `src/inquiry`,
 * `src/scouting`) per due motivi: `TaobaoModule` ne usa alcuni **file** — la
 * lettura dei fogli Excel, la normalizzazione delle richieste, la crittografia
 * delle sessioni — e rimettere in linea uno di quei moduli deve restare una
 * riga di import, non un recupero da git.
 */
@Module({
  imports: [TaobaoModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Prima di tutto il resto: ogni handler e ogni servizio più in basso deve
    // poter sapere in che lingua rispondere senza riceverla come parametro.
    consumer.apply(LocaleMiddleware).forRoutes("*path");
  }
}
