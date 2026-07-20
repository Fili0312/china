import { AlibabaAdapter } from "./adapters/alibaba";
import { AliExpressAdapter } from "./adapters/aliexpress";
import { ChinagoodsAdapter } from "./adapters/chinagoods";
import { MadeInChinaAdapter } from "./adapters/made-in-china";
import { MockAdapter } from "./adapters/mock";
import { YiwugoAdapter } from "./adapters/yiwugo";
import type { AdapterDescriptor, MarketplaceAdapter } from "./types";

/**
 * Per aggiungere un marketplace:
 * 1. crea src/adapters/<nome>.ts implementando MarketplaceAdapter;
 * 2. registralo qui con nome e lingue supportate;
 * 3. aggiungi il nome a MARKETPLACES nel .env.
 * Nient'altro nella piattaforma deve cambiare.
 */
const DESCRIPTORS: AdapterDescriptor[] = [
  { name: "mock", languages: ["en", "zh"], create: () => new MockAdapter() },
  { name: "alibaba", languages: ["en"], create: () => new AlibabaAdapter() },
  {
    name: "aliexpress",
    languages: ["en", "zh"],
    create: () => new AliExpressAdapter(),
  },
  {
    name: "chinagoods",
    languages: ["en"],
    create: () => new ChinagoodsAdapter(),
  },
  {
    name: "made-in-china",
    languages: ["en"],
    create: () => new MadeInChinaAdapter(),
  },
  {
    name: "yiwugo",
    languages: ["en", "zh"],
    create: () => new YiwugoAdapter(),
  },
  // TODO: adapter 1688 (query in cinese) — richiede gestione anti-bot/login.
];

const byName = new Map(DESCRIPTORS.map((d) => [d.name, d]));
const instances = new Map<string, MarketplaceAdapter>();

export function getDescriptor(name: string): AdapterDescriptor {
  const d = byName.get(name);
  if (!d) {
    throw new Error(
      `Marketplace sconosciuto: "${name}". Disponibili: ${[...byName.keys()].join(", ")}`
    );
  }
  return d;
}

export function getAdapter(name: string): MarketplaceAdapter {
  let inst = instances.get(name);
  if (!inst) {
    inst = getDescriptor(name).create();
    instances.set(name, inst);
  }
  return inst;
}

/** Marketplace attivi dal .env (es. alibaba,aliexpress,made-in-china). */
export function activeMarketplaces(): string[] {
  const raw = process.env.MARKETPLACES || "mock";
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  names.forEach(getDescriptor); // valida subito i nomi
  return names;
}
