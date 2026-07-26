import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { prisma } from "@china/db";
import type {
  ClientSummary,
  CreateClientRequest,
  UpdateClientRequest,
} from "@china/shared";
import { t, type ApiMessageKey } from "../i18n/messages";

/**
 * I clienti dello scouting v1.
 *
 * Esiste per una ragione sola, e non è organizzativa: **separare i dati**. Ogni
 * file, ogni analisi e ogni ricerca appartengono a un cliente, e tutte le
 * letture partono da lì. Un servizio che accettasse un `datasetId` senza
 * chiedere di chi è renderebbe possibile — con un id indovinato o copiato —
 * mostrare a un cliente il lavoro fatto per un altro.
 *
 * Da qui la regola che attraversa tutto il modulo: **niente si legge per id
 * soltanto**. `assertOwnership` è il punto in cui quella regola diventa codice.
 */
@Injectable()
export class ClientService {
  /** Elenco dei clienti, con quanto lavoro esiste per ciascuno. */
  async list(includeArchived = false): Promise<ClientSummary[]> {
    const clients = await prisma.client.findMany({
      where: includeArchived ? {} : { archived: false },
      orderBy: { name: "asc" },
      include: { _count: { select: { datasets: true, jobs: true } } },
    });
    return clients.map(toSummary);
  }

  async get(clientId: string): Promise<ClientSummary> {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      include: { _count: { select: { datasets: true, jobs: true } } },
    });
    if (!client) throw new NotFoundException(t("err.clientNotFound", { id: clientId }));
    return toSummary(client);
  }

  async create(input: CreateClientRequest): Promise<ClientSummary> {
    const slug = await this.uniqueSlug(input.name);
    const client = await prisma.client.create({
      data: {
        name: input.name.trim(),
        slug,
        contact: input.contact?.trim() || null,
        notes: input.notes?.trim() || null,
      },
      include: { _count: { select: { datasets: true, jobs: true } } },
    });
    return toSummary(client);
  }

  async update(clientId: string, input: UpdateClientRequest): Promise<ClientSummary> {
    await this.get(clientId);
    const client = await prisma.client.update({
      where: { id: clientId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.contact !== undefined ? { contact: input.contact?.trim() || null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      },
      include: { _count: { select: { datasets: true, jobs: true } } },
    });
    return toSummary(client);
  }

  /**
   * Verifica che una risorsa appartenga davvero al cliente indicato.
   *
   * Lancia `NotFoundException` e non `Forbidden`: a chi chiede una risorsa di
   * un altro cliente non si conferma nemmeno che esista.
   *
   * `resource` è una chiave del dizionario (`resource.file`, `resource.job`…)
   * e non il nome già scritto: il messaggio esce nella lingua di chi lo legge,
   * e il tipo impedisce di passare qui una parola sciolta.
   */
  assertOwnership(
    clientId: string,
    resourceClientId: string,
    resource: Extract<ApiMessageKey, `resource.${string}`>
  ): void {
    if (clientId !== resourceClientId) {
      throw new NotFoundException(t("err.notForThisClient", { resource: t(resource) }));
    }
  }

  /**
   * Slug leggibile e unico.
   *
   * I nomi cinesi non producono caratteri latini: in quel caso lo slug ricade
   * su `cliente`, e il suffisso numerico lo rende comunque distinguibile.
   */
  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "cliente";

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await prisma.client.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    throw new BadRequestException(
      t("err.tooManySimilarNames")
    );
  }
}

function toSummary(client: {
  id: string;
  name: string;
  slug: string;
  contact: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: Date;
  _count: { datasets: number; jobs: number };
}): ClientSummary {
  return {
    clientId: client.id,
    name: client.name,
    slug: client.slug,
    contact: client.contact,
    notes: client.notes,
    archived: client.archived,
    createdAt: client.createdAt.toISOString(),
    datasetCount: client._count.datasets,
    jobCount: client._count.jobs,
  };
}
