import type {
  TaobaoDatasetSummary,
  TaobaoJobSummary,
  TaobaoPipelineState,
} from "@china/shared";

export type ScoutingV2HistoryKind = "pipeline" | "job" | "upload";
export type ScoutingV2HistoryStatus =
  | TaobaoPipelineState["status"]
  | TaobaoJobSummary["status"]
  | "UPLOADED";

/**
 * Una riga dello storico v2.
 *
 * I dati restano nelle tabelle canoniche (file, analisi, job e pipeline): questa
 * è soltanto la proiezione che serve alla pagina. In particolare non si creano
 * pipeline fittizie per i file e i job più vecchi.
 */
export interface ScoutingV2HistoryEntry {
  key: string;
  kind: ScoutingV2HistoryKind;
  clientId: string;
  datasetId: string;
  fileName: string;
  uploadedAt: string | null;
  processedAt: string | null;
  finishedAt: string | null;
  totalRows: number;
  status: ScoutingV2HistoryStatus;
  analysisRunCount: number;
  jobCount: number;
  pipeline: TaobaoPipelineState | null;
  job: TaobaoJobSummary | null;
}

export function historyJobId(entry: ScoutingV2HistoryEntry): string | null {
  return entry.pipeline?.jobId ?? entry.job?.jobId ?? null;
}

export function historyHasResults(entry: ScoutingV2HistoryEntry): boolean {
  if (!historyJobId(entry)) return false;
  return (
    entry.pipeline?.status === "COMPLETED" ||
    entry.job?.status === "COMPLETED" ||
    entry.job?.status === "COMPLETED_WITH_ERRORS"
  );
}

/**
 * Unisce le tre viste già esistenti senza duplicare la stessa lavorazione:
 *
 * - una pipeline assorbe il job a cui è collegata;
 * - un job senza pipeline resta una lavorazione storica riutilizzabile;
 * - un file compare da solo soltanto se non ha né job né pipeline.
 */
export function buildScoutingV2History(
  clientId: string,
  datasets: readonly TaobaoDatasetSummary[],
  jobs: readonly TaobaoJobSummary[],
  pipelines: readonly TaobaoPipelineState[]
): ScoutingV2HistoryEntry[] {
  // Gli endpoint sono già client-scoped, ma questa proiezione è l'ultimo
  // confine prima del rendering: dati che dichiarano un owner diverso non
  // devono diventare visibili neppure in caso di risposta o cache errata.
  const ownedDatasets = datasets.filter((dataset) => dataset.clientId === clientId);
  const ownedJobs = jobs.filter((job) => job.clientId === clientId);
  const ownedPipelines = pipelines.filter(
    (pipeline) => pipeline.clientId === clientId
  );
  const datasetsById = new Map(
    ownedDatasets.map((dataset) => [dataset.datasetId, dataset])
  );
  const jobsById = new Map(ownedJobs.map((job) => [job.jobId, job]));
  const coveredJobIds = new Set(
    ownedPipelines.flatMap((pipeline) => (pipeline.jobId ? [pipeline.jobId] : []))
  );
  const workedDatasetIds = new Set<string>();
  const entries: ScoutingV2HistoryEntry[] = [];

  for (const pipeline of ownedPipelines) {
    const dataset = datasetsById.get(pipeline.datasetId);
    const job = pipeline.jobId ? (jobsById.get(pipeline.jobId) ?? null) : null;
    workedDatasetIds.add(pipeline.datasetId);
    entries.push({
      key: `pipeline:${pipeline.pipelineId}`,
      kind: "pipeline",
      clientId: pipeline.clientId,
      datasetId: pipeline.datasetId,
      fileName: pipeline.fileName,
      uploadedAt: dataset?.createdAt ?? pipeline.uploadedAt,
      processedAt: pipeline.startedAt ?? job?.startedAt ?? job?.createdAt ?? null,
      finishedAt: pipeline.finishedAt ?? job?.finishedAt ?? null,
      totalRows: pipeline.totalRows,
      status: pipeline.status,
      analysisRunCount: dataset?.analysisRunCount ?? (pipeline.analysisRunId ? 1 : 0),
      jobCount: dataset?.jobCount ?? (pipeline.jobId ? 1 : 0),
      pipeline,
      job,
    });
  }

  for (const job of ownedJobs) {
    workedDatasetIds.add(job.datasetId);
    if (coveredJobIds.has(job.jobId)) continue;
    const dataset = datasetsById.get(job.datasetId);
    entries.push({
      key: `job:${job.jobId}`,
      kind: "job",
      clientId: job.clientId,
      datasetId: job.datasetId,
      fileName: job.fileName,
      uploadedAt: dataset?.createdAt ?? job.createdAt,
      processedAt: job.startedAt ?? job.createdAt,
      finishedAt: job.finishedAt,
      totalRows: job.totalRows || dataset?.totalRows || 0,
      status: job.status,
      analysisRunCount: dataset?.analysisRunCount ?? 0,
      jobCount: dataset?.jobCount ?? 1,
      pipeline: null,
      job,
    });
  }

  for (const dataset of ownedDatasets) {
    if (workedDatasetIds.has(dataset.datasetId)) continue;
    entries.push({
      key: `upload:${dataset.datasetId}`,
      kind: "upload",
      clientId: dataset.clientId,
      datasetId: dataset.datasetId,
      fileName: dataset.fileName,
      uploadedAt: dataset.createdAt,
      processedAt: null,
      finishedAt: null,
      totalRows: dataset.totalRows,
      status: "UPLOADED",
      analysisRunCount: dataset.analysisRunCount,
      jobCount: dataset.jobCount,
      pipeline: null,
      job: null,
    });
  }

  return sortHistory(entries);
}

/**
 * Aggiorna immediatamente la fotografia mostrata durante il polling.
 *
 * Il refresh completo dei tre endpoint resta la fonte definitiva; questo merge
 * evita però che, tornando allo storico subito dopo la fine, la riga dica ancora
 * "in corso" o nasconda i download appena diventati disponibili.
 */
export function mergePipelineIntoHistory(
  history: readonly ScoutingV2HistoryEntry[],
  pipeline: TaobaoPipelineState
): ScoutingV2HistoryEntry[] {
  const previousPipeline = history.find(
    (entry) => entry.pipeline?.pipelineId === pipeline.pipelineId
  );
  const previousUpload = history.find(
    (entry) => entry.kind === "upload" && entry.datasetId === pipeline.datasetId
  );
  const previousJob = pipeline.jobId
    ? history.find((entry) => entry.job?.jobId === pipeline.jobId)
    : undefined;
  const base = previousPipeline ?? previousUpload ?? previousJob;
  const linkedJob =
    previousPipeline?.job ??
    (previousJob?.job?.jobId === pipeline.jobId ? previousJob.job : null);

  const next: ScoutingV2HistoryEntry = {
    key: `pipeline:${pipeline.pipelineId}`,
    kind: "pipeline",
    clientId: pipeline.clientId,
    datasetId: pipeline.datasetId,
    fileName: pipeline.fileName,
    uploadedAt: base?.uploadedAt ?? pipeline.uploadedAt,
    processedAt: pipeline.startedAt ?? base?.processedAt ?? null,
    finishedAt: pipeline.finishedAt,
    totalRows: pipeline.totalRows,
    status: pipeline.status,
    analysisRunCount: Math.max(
      base?.analysisRunCount ?? 0,
      pipeline.analysisRunId ? 1 : 0
    ),
    jobCount: Math.max(base?.jobCount ?? 0, pipeline.jobId ? 1 : 0),
    pipeline,
    job: linkedJob,
  };

  return sortHistory([
    ...history.filter((entry) => {
      if (entry.pipeline?.pipelineId === pipeline.pipelineId) return false;
      if (entry.kind === "upload" && entry.datasetId === pipeline.datasetId) return false;
      if (pipeline.jobId && entry.kind === "job" && entry.job?.jobId === pipeline.jobId) {
        return false;
      }
      return true;
    }),
    next,
  ]);
}

function sortHistory(
  entries: readonly ScoutingV2HistoryEntry[]
): ScoutingV2HistoryEntry[] {
  return [...entries].sort((left, right) => {
    const timeDifference = historyTime(right) - historyTime(left);
    return timeDifference || left.key.localeCompare(right.key);
  });
}

function historyTime(entry: ScoutingV2HistoryEntry): number {
  const value = entry.processedAt ?? entry.uploadedAt;
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
