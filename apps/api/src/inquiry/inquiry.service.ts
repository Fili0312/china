import { Injectable, NotFoundException } from "@nestjs/common";
import type { InquiryImportResult, InquirySource } from "@china/shared";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
  InquiryWorkbookError,
  parseInquiryWorkbook,
} from "./inquiry-workbook";

/** Estensioni accettate: il formato .xls storico è quello dei fogli 询价. */
const ALLOWED_EXTENSIONS = new Set([".xls", ".xlsx", ".xlsm"]);

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Cartella dei fogli di richiesta. In sviluppo (`tsx src/main.ts`) e in
 * produzione (`node dist/main.js`) `__dirname` cambia di un livello, quindi il
 * percorso viene cercato fra i candidati validi, come per il .env di root.
 */
function resolveDataDirectory(): string {
  const candidates = [
    process.env.INQUIRY_DATA_DIR,
    resolve(process.cwd(), "../../data/inquiries"),
    resolve(__dirname, "../../../../data/inquiries"),
    resolve(process.cwd(), "data/inquiries"),
  ].filter((value): value is string => Boolean(value));

  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

@Injectable()
export class InquiryService {
  private readonly dataDirectory = resolveDataDirectory();

  get maxUploadBytes(): number {
    return numericEnv("INQUIRY_MAX_UPLOAD_BYTES", 25 * 1024 * 1024);
  }

  /** Fogli di richiesta disponibili sul server. */
  async listSources(): Promise<InquirySource[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dataDirectory);
    } catch {
      return [];
    }

    const sources: InquirySource[] = [];
    for (const entry of entries) {
      if (!ALLOWED_EXTENSIONS.has(extname(entry).toLowerCase())) continue;
      // I file temporanei di Excel non sono richieste da mostrare.
      if (entry.startsWith("~$") || entry.startsWith(".")) continue;
      try {
        const info = await stat(resolve(this.dataDirectory, entry));
        if (!info.isFile()) continue;
        sources.push({
          name: entry,
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      } catch {
        // Un file sparito fra readdir e stat non deve rompere l'elenco.
      }
    }
    return sources.sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Legge un foglio di richiesta già presente sul server. */
  async readSource(
    source: string,
    sheet: string
  ): Promise<InquiryImportResult> {
    // `source` arriva dal client: solo un nome di file, mai un percorso.
    const fileName = basename(source);
    if (fileName !== source || !ALLOWED_EXTENSIONS.has(extname(fileName).toLowerCase())) {
      throw new NotFoundException(`File di richiesta non valido: ${source}`);
    }

    const path = resolve(this.dataDirectory, fileName);
    if (!path.startsWith(resolve(this.dataDirectory) + "/")) {
      throw new NotFoundException(`File di richiesta non valido: ${source}`);
    }

    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      throw new NotFoundException(
        `File di richiesta non trovato: ${fileName}. Copialo in ${this.dataDirectory}.`
      );
    }
    return this.parse(content, fileName, sheet);
  }

  /** Legge un foglio caricato dall'interfaccia. */
  parse(
    content: Buffer,
    fileName: string,
    sheet: string
  ): InquiryImportResult {
    return parseInquiryWorkbook(content, {
      source: basename(fileName),
      sheet,
    });
  }
}

export { InquiryWorkbookError };
