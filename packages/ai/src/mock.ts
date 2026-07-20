import {
  GeneratedQueries,
  MatchResult,
  ParsedItem,
  ParsedRequest,
} from "@china/shared";
import type { MatchCandidateInput, MatchItemInput } from "./match-candidates";

/**
 * Implementazioni finte delle chiamate Claude, per sviluppare/testare la
 * pipeline (code, flow, SSE, preventivo) senza API key e senza costi.
 * Attivate con AI_MOCK=1. NON usare in produzione.
 */

export function mockParseRequest(rawText: string): ParsedRequest {
  const items: ParsedItem[] = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 2)
    .map((line) => {
      // "20x tazza rossa" / "20 tazza" → quantità 20
      const m = line.match(/^(\d+)\s*[xX×]?\s+(.*)$/);
      const quantity = m ? Math.max(1, parseInt(m[1], 10)) : 1;
      const name = (m ? m[2] : line).slice(0, 120);
      return {
        name,
        quantity,
        color: null,
        size: null,
        attributes: {},
        notes: null,
      };
    });
  return { items };
}

export function mockGenerateQueries(items: ParsedItem[]): GeneratedQueries {
  return {
    queries: items.map((it, index) => ({
      index,
      queryEn: it.name,
      queryZh: it.name, // in mock non traduciamo
    })),
  };
}

export function mockMatchCandidates(
  _item: MatchItemInput,
  candidates: MatchCandidateInput[]
): MatchResult {
  return {
    selections: candidates.slice(0, 3).map((c, i) => ({
      candidateId: c.id,
      score: 0.9 - i * 0.15,
      reason: "Selezione mock (AI_MOCK=1)",
      variant: null,
    })),
  };
}
