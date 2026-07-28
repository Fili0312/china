import type { V2RetryEstimate, V2RetryMode, V2RetryResult } from "@china/shared";
import { api } from "../../lib/api";

/**
 * Le due chiamate della riprova a scala, in un posto solo.
 *
 * Le usano sia la vista di fine corsa sia quella di una corsa riaperta dalla
 * cronologia: riprovare una riga scoperta ha senso anche — soprattutto —
 * qualche giorno dopo, quando qualcuno riapre il file e guarda cosa è rimasto
 * indietro. Due copie di queste due funzioni sarebbero due comportamenti
 * destinati a divergere.
 */

export function retryPath(clientId: string, pipelineId: string): string {
  return `/taobao/clients/${clientId}/pipelines/${pipelineId}`;
}

export function estimateRetryRows(
  clientId: string,
  pipelineId: string,
  rowNumbers: readonly number[],
  mode: V2RetryMode
): Promise<V2RetryEstimate> {
  return api<V2RetryEstimate>(`${retryPath(clientId, pipelineId)}/retry-estimate`, {
    method: "POST",
    body: JSON.stringify({ rowNumbers, mode }),
  });
}

export function retryRowsRequest(
  clientId: string,
  pipelineId: string,
  rowNumbers: readonly number[],
  mode: V2RetryMode
): Promise<V2RetryResult> {
  return api<V2RetryResult>(`${retryPath(clientId, pipelineId)}/retry`, {
    method: "POST",
    body: JSON.stringify({ rowNumbers, mode }),
  });
}
