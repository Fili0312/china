import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { prisma } from "@china/db";
import {
  decryptSession,
  encryptSession,
  sessionDigest,
  summarizeCookies,
  SessionDecryptError,
  SessionSecretMissingError,
} from "./session-crypto";

/**
 * Sessioni degli account 1688 e Taobao.
 *
 * `s.1688.com` risponde con una punish page e `s.taobao.com` richiede il
 * login: nessuna delle due è raggiungibile senza una sessione autenticata.
 * Il login viene fatto **a mano** dall'utente nel proprio browser, e qui si
 * incollano i cookie risultanti: automatizzare l'accesso significherebbe
 * gestire password, SMS e captcha di un account reale, che è sia fragile sia
 * fuori da ciò che un servizio dovrebbe custodire.
 *
 * Da qui in poi i cookie sono trattati come credenziali: cifrati a riposo,
 * mai restituiti da un'API, mai scritti nei log.
 */

/** Marketplace che richiedono una sessione per essere interrogati. */
export const SESSION_MARKETPLACES = ["1688", "taobao-web"] as const;
export type SessionMarketplace = (typeof SESSION_MARKETPLACES)[number];

/** Margine entro cui una sessione va considerata in scadenza. */
const EXPIRY_WARNING_MS = 48 * 3_600_000;

export interface SessionStatus {
  marketplace: string;
  label: string | null;
  connected: boolean;
  /** Nomi dei cookie presenti, senza valori. */
  cookieNames: string[];
  expiresAt: string | null;
  expired: boolean;
  /** `true` quando scade entro due giorni: va rinnovata prima che serva. */
  expiringSoon: boolean;
  lastUsedAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

@Injectable()
export class MarketplaceSessionService {
  private readonly logger = new Logger("MarketplaceSession");

  private get secret(): string | undefined {
    return process.env.SCOUTING_SESSION_SECRET;
  }

  /**
   * Salva (o sostituisce) la sessione di un marketplace.
   *
   * @param cookiesJson i cookie esportati dal browser, in JSON.
   */
  async connect(
    marketplace: string,
    cookiesJson: string,
    label: string | null
  ): Promise<SessionStatus> {
    if (!(SESSION_MARKETPLACES as readonly string[]).includes(marketplace)) {
      throw new BadRequestException(
        `Marketplace senza sessione: ${marketplace}. Disponibili: ${SESSION_MARKETPLACES.join(", ")}.`
      );
    }

    const summary = summarizeCookies(cookiesJson);
    if (summary.cookies.length === 0) {
      throw new BadRequestException(
        "Nessun cookie riconosciuto: incolla l'esportazione JSON dei cookie " +
          "del sito, non il solo header Cookie."
      );
    }

    let encrypted;
    try {
      encrypted = encryptSession(cookiesJson, this.secret);
    } catch (error) {
      if (error instanceof SessionSecretMissingError) {
        // Il messaggio spiega cosa fare e non contiene nulla di sensibile.
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const data = {
      label,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      digest: sessionDigest(cookiesJson),
      cookieNames: summary.cookies.map((cookie) => cookie.name),
      expiresAt: summary.expiresAt,
      lastError: null,
      lastFailedAt: null,
    };

    await prisma.marketplaceSession.upsert({
      where: { marketplace },
      create: { marketplace, ...data },
      update: data,
    });

    // Nel log finisce il fatto, mai il contenuto.
    this.logger.log(
      `sessione ${marketplace} collegata (${data.cookieNames.length} cookie, ` +
        `scadenza ${summary.expiresAt?.toISOString() ?? "non dichiarata"})`
    );
    return this.status(marketplace);
  }

  /** Stato di tutte le sessioni. Non espone mai i cookie. */
  async list(): Promise<SessionStatus[]> {
    const sessions = await prisma.marketplaceSession.findMany({
      orderBy: { marketplace: "asc" },
    });
    return sessions.map((session) => toStatus(session));
  }

  async status(marketplace: string): Promise<SessionStatus> {
    const session = await prisma.marketplaceSession.findUnique({
      where: { marketplace },
    });
    if (!session) {
      throw new NotFoundException(
        `Nessuna sessione collegata per ${marketplace}.`
      );
    }
    return toStatus(session);
  }

  async disconnect(marketplace: string): Promise<void> {
    await prisma.marketplaceSession
      .delete({ where: { marketplace } })
      .catch(() => {
        throw new NotFoundException(
          `Nessuna sessione collegata per ${marketplace}.`
        );
      });
    this.logger.log(`sessione ${marketplace} scollegata`);
  }

  /**
   * Restituisce i cookie in chiaro **solo** a chi deve usarli per navigare.
   *
   * Volutamente non è esposto da nessun endpoint: è un metodo interno, pensato
   * per essere passato direttamente a un contesto Playwright. Una sessione
   * scaduta non viene restituita, perché usarla produrrebbe una pagina di
   * login scambiata per un risultato vuoto.
   */
  async loadCookies(marketplace: string): Promise<unknown[]> {
    const session = await prisma.marketplaceSession.findUnique({
      where: { marketplace },
    });
    if (!session) {
      throw new NotFoundException(
        `Nessuna sessione collegata per ${marketplace}: collegala prima di ` +
          "usare questa fonte."
      );
    }
    if (isExpired(session.expiresAt)) {
      await this.markFailure(
        marketplace,
        "Sessione scaduta: va ricollegata dal browser."
      );
      throw new BadRequestException(
        `La sessione ${marketplace} è scaduta il ` +
          `${session.expiresAt?.toISOString().slice(0, 10)}: ricollegala.`
      );
    }

    let plaintext: string;
    try {
      plaintext = decryptSession(session, this.secret);
    } catch (error) {
      const message =
        error instanceof SessionDecryptError || error instanceof SessionSecretMissingError
          ? error.message
          : "Sessione non leggibile.";
      await this.markFailure(marketplace, message);
      throw new BadRequestException(message);
    }

    await prisma.marketplaceSession.update({
      where: { marketplace },
      data: { lastUsedAt: new Date(), lastError: null },
    });

    const parsed = JSON.parse(plaintext) as unknown;
    return Array.isArray(parsed)
      ? parsed
      : ((parsed as { cookies?: unknown[] }).cookies ?? []);
  }

  /** Registra un fallimento d'uso, per far capire che va ricollegata. */
  async markFailure(marketplace: string, reason: string): Promise<void> {
    await prisma.marketplaceSession
      .update({
        where: { marketplace },
        data: { lastFailedAt: new Date(), lastError: reason.slice(0, 300) },
      })
      .catch(() => undefined);
  }
}

function isExpired(expiresAt: Date | null): boolean {
  return expiresAt != null && expiresAt.getTime() <= Date.now();
}

function toStatus(session: {
  marketplace: string;
  label: string | null;
  cookieNames: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastFailedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
}): SessionStatus {
  const expired = isExpired(session.expiresAt);
  return {
    marketplace: session.marketplace,
    label: session.label,
    connected: !expired,
    cookieNames: session.cookieNames,
    expiresAt: session.expiresAt?.toISOString() ?? null,
    expired,
    expiringSoon:
      !expired &&
      session.expiresAt != null &&
      session.expiresAt.getTime() - Date.now() < EXPIRY_WARNING_MS,
    lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
    lastFailedAt: session.lastFailedAt?.toISOString() ?? null,
    lastError: session.lastError,
    updatedAt: session.updatedAt.toISOString(),
  };
}

export { toStatus, isExpired };
