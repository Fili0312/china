import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { prisma } from "@china/db";
import {
  TAOBAO_SESSION_MARKETPLACE,
  type ConnectTaobaoSessionRequest,
  type TaobaoSessionStatus,
} from "@china/shared";
import {
  decryptSession,
  encryptSession,
  sessionDigest,
  summarizeCookies,
  SessionDecryptError,
  SessionSecretMissingError,
} from "../scouting/session-crypto";
import { t } from "../i18n/messages";

/**
 * L'account Taobao collegato.
 *
 * Il collegamento è **manuale, e deve restarlo**: l'utente apre Taobao nel
 * proprio browser, fa il login come farebbe sempre — password, SMS, verifica
 * scorrevole, quello che il sito chiede quel giorno — e incolla qui i cookie
 * della sessione già autenticata. Il sistema non vede né conserva username,
 * password, codici SMS o captcha: non esiste un campo in cui possano entrare,
 * ed è una scelta di progetto, non una mancanza.
 *
 * Da quel momento i cookie sono credenziali a tutti gli effetti:
 *
 * - cifrati con AES-256-GCM prima di toccare il database (`session-crypto`);
 * - mai restituiti da un'API: di una sessione si espone solo lo **stato** —
 *   collegata, scadenza, ultimo uso, quali cookie ci sono per nome;
 * - mai scritti nei log, nemmeno in caso di errore;
 * - decifrati solo da `loadCookies`, che è interno e serve unicamente a
 *   costruire il contesto Playwright.
 *
 * Riusa la stessa infrastruttura delle sessioni dello scouting classico
 * (`MarketplaceSession`, marketplace `taobao-web`): duplicarla avrebbe
 * significato mantenere due implementazioni di crittografia, che è il modo
 * più affidabile di finire con una delle due sbagliata.
 */
@Injectable()
export class TaobaoSessionService {
  private readonly logger = new Logger("TaobaoSession");

  private get secret(): string | undefined {
    return process.env.SCOUTING_SESSION_SECRET;
  }

  /** `false` se manca il segreto: senza, cifrare è impossibile. */
  get encryptionReady(): boolean {
    return Boolean((this.secret ?? "").trim());
  }

  /** Stato della sessione. Non espone mai i cookie. */
  async status(): Promise<TaobaoSessionStatus> {
    const session = await prisma.marketplaceSession.findUnique({
      where: { marketplace: TAOBAO_SESSION_MARKETPLACE },
    });

    if (!session) {
      return {
        connected: false,
        label: null,
        cookieNames: [],
        expiresAt: null,
        expired: false,
        expiringSoon: false,
        lastUsedAt: null,
        lastFailedAt: null,
        lastError: null,
        encryptionReady: this.encryptionReady,
      };
    }

    const expired = session.expiresAt != null && session.expiresAt.getTime() <= Date.now();
    return {
      connected: !expired,
      label: session.label,
      cookieNames: session.cookieNames,
      expiresAt: session.expiresAt?.toISOString() ?? null,
      expired,
      expiringSoon:
        !expired &&
        session.expiresAt != null &&
        session.expiresAt.getTime() - Date.now() < 48 * 3_600_000,
      lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
      lastFailedAt: session.lastFailedAt?.toISOString() ?? null,
      lastError: session.lastError,
      encryptionReady: this.encryptionReady,
    };
  }

  /** Collega (o sostituisce) la sessione. */
  async connect(input: ConnectTaobaoSessionRequest): Promise<TaobaoSessionStatus> {
    const summary = summarizeCookies(input.cookiesJson);
    if (summary.cookies.length === 0) {
      throw new BadRequestException(
        t("err.noCookies")
      );
    }

    // Un'esportazione senza i cookie di sessione è formalmente valida e
    // praticamente inutile: meglio dirlo adesso che a ricerca fallita.
    const names = new Set(summary.cookies.map((cookie) => cookie.name));
    if (!names.has("_tb_token_") && !names.has("cookie2") && !names.has("sgcookie")) {
      this.logger.warn(
        "sessione collegata senza i cookie di autenticazione tipici di Taobao"
      );
    }

    let encrypted;
    try {
      encrypted = encryptSession(input.cookiesJson, this.secret);
    } catch (error) {
      if (error instanceof SessionSecretMissingError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const data = {
      label: input.label?.trim() || null,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      digest: sessionDigest(input.cookiesJson),
      cookieNames: summary.cookies.map((cookie) => cookie.name),
      expiresAt: summary.expiresAt,
      lastError: null,
      lastFailedAt: null,
    };

    await prisma.marketplaceSession.upsert({
      where: { marketplace: TAOBAO_SESSION_MARKETPLACE },
      create: { marketplace: TAOBAO_SESSION_MARKETPLACE, ...data },
      update: data,
    });

    // Nel log finisce il fatto, mai il contenuto.
    this.logger.log(
      `account Taobao collegato (${data.cookieNames.length} cookie, scadenza ` +
        `${summary.expiresAt?.toISOString() ?? "non dichiarata"})`
    );
    return this.status();
  }

  async disconnect(): Promise<TaobaoSessionStatus> {
    await prisma.marketplaceSession
      .delete({ where: { marketplace: TAOBAO_SESSION_MARKETPLACE } })
      .catch(() => undefined);
    this.logger.log("account Taobao scollegato");
    return this.status();
  }

  /**
   * Cookie in chiaro per Playwright.
   *
   * Deliberatamente non esposto da nessun endpoint: è un metodo interno, e
   * l'unico consumatore legittimo è il contesto del browser. Una sessione
   * scaduta non viene restituita, perché navigare con essa produrrebbe una
   * pagina di login scambiata per «nessun risultato».
   */
  async loadCookies(): Promise<unknown[] | null> {
    const session = await prisma.marketplaceSession.findUnique({
      where: { marketplace: TAOBAO_SESSION_MARKETPLACE },
    });
    if (!session) return null;

    if (session.expiresAt != null && session.expiresAt.getTime() <= Date.now()) {
      await this.markFailure("Sessione scaduta: va ricollegata dal browser.");
      return null;
    }

    let plaintext: string;
    try {
      plaintext = decryptSession(session, this.secret);
    } catch (error) {
      const message =
        error instanceof SessionDecryptError || error instanceof SessionSecretMissingError
          ? error.message
          : "Sessione non leggibile.";
      await this.markFailure(message);
      return null;
    }

    await prisma.marketplaceSession.update({
      where: { marketplace: TAOBAO_SESSION_MARKETPLACE },
      data: { lastUsedAt: new Date(), lastError: null },
    });

    const parsed = JSON.parse(plaintext) as unknown;
    return Array.isArray(parsed)
      ? parsed
      : ((parsed as { cookies?: unknown[] }).cookies ?? []);
  }

  /** Registra un fallimento d'uso: è ciò che fa capire che va ricollegata. */
  async markFailure(reason: string): Promise<void> {
    await prisma.marketplaceSession
      .update({
        where: { marketplace: TAOBAO_SESSION_MARKETPLACE },
        data: { lastFailedAt: new Date(), lastError: reason.slice(0, 300) },
      })
      .catch(() => undefined);
  }
}
