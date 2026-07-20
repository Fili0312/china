import { Browser, BrowserContext, chromium } from "playwright";

/**
 * Un solo browser Chromium condiviso per processo worker; ogni ricerca usa
 * un context isolato (cookie/sessione separati) che va chiuso dal chiamante.
 */
let browser: Browser | null = null;
let browserLaunch: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  browser = null;

  if (!browserLaunch) {
    let pending!: Promise<Browser>;
    pending = chromium
      .launch({
        headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
      })
      .then(async (launched) => {
        // closeBrowser() può essere chiamato mentre Chromium si sta avviando.
        // In quel caso questa istanza è ormai obsoleta e non deve tornare globale.
        if (browserLaunch !== pending) {
          await launched.close().catch(() => {});
          throw new Error("Avvio Chromium annullato durante la chiusura");
        }

        launched.once("disconnected", () => {
          if (browser === launched) browser = null;
          if (browserLaunch === pending) browserLaunch = null;
        });
        browser = launched;
        return launched;
      });
    browserLaunch = pending;

    // Un errore di launch non deve lasciare in cache una Promise rigettata.
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (browserLaunch === pending) browserLaunch = null;
      });
  }

  return browserLaunch;
}

export async function newContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  return b.newContext({
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
  });
}

export async function closeBrowser(): Promise<void> {
  const active = browser;
  const pending = browserLaunch;
  browser = null;
  browserLaunch = null;

  await active?.close().catch(() => {});
  // Se il launch era ancora in corso, il controllo d'identità in getBrowser()
  // chiuderà l'istanza appena creata; qui attendiamo soltanto che termini.
  await pending?.catch(() => {});
}
