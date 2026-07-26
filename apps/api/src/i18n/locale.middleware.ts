import { Injectable, type NestMiddleware } from "@nestjs/common";
import { resolveLocale, runWithLocale } from "./request-locale";

/**
 * La parte di richiesta che serve a scegliere la lingua.
 *
 * Tipo strutturale e non `express.Request`: `express` non è risolvibile da
 * `apps/api` con pnpm — vale la stessa ragione documentata in
 * `common/binary-body.ts` — e per due campi non vale la dipendenza.
 */
interface LocaleRequest {
  query?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Apre il contesto di lingua per l'intera richiesta.
 *
 * Va installato prima di ogni altra cosa: se `next()` venisse chiamato fuori
 * da `runWithLocale`, tutto ciò che accade dopo — controller, servizi, fogli
 * Excel — ricadrebbe silenziosamente sull'inglese.
 */
@Injectable()
export class LocaleMiddleware implements NestMiddleware {
  use(request: LocaleRequest, _response: unknown, next: () => void): void {
    const header = request.headers["accept-language"];
    const locale = resolveLocale(
      request.query?.lang,
      Array.isArray(header) ? header[0] : header
    );
    runWithLocale(locale, next);
  }
}
