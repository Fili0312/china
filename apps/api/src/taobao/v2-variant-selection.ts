import type { TaobaoProductRecord } from "@china/shared";
import type { V2RequirementContext } from "./v2-requirement-policy";

export interface V2VariantSelection {
  selectedVariant: string | null;
  requiresHumanChoice: boolean;
  choices: string[];
}

function compact(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function optionMatchesRequirements(
  option: string,
  requirements: readonly string[]
): boolean {
  const candidate = compact(option);
  if (!candidate) return false;
  return requirements.some((requirement) => {
    const expected = compact(requirement);
    if (!expected) return false;
    return candidate.includes(expected) || expected.includes(candidate);
  });
}

/**
 * Selezione variante deterministica esclusiva della v2.
 *
 * Una sola opzione o un'unica opzione che contiene un vincolo esplicito può
 * essere scelta automaticamente. Se più opzioni restano plausibili non viene
 * inventata una preferenza commerciale: la riga richiede `CHOOSE_VARIANT`.
 */
export function selectV2Variant(
  product: Pick<TaobaoProductRecord, "sku" | "variants">,
  context: V2RequirementContext
): V2VariantSelection {
  const sku = product.sku?.trim();
  if (sku) {
    return {
      selectedVariant: sku,
      requiresHumanChoice: false,
      choices: [],
    };
  }

  const groups = (product.variants ?? [])
    .map((group) => ({
      name: group.name.trim(),
      options: [...new Set(group.options.map((option) => option.trim()).filter(Boolean))],
    }))
    .filter((group) => group.options.length > 0);
  if (groups.length === 0) {
    return {
      selectedVariant: null,
      requiresHumanChoice: false,
      choices: [],
    };
  }

  const requirements = [
    ...context.modelTokens,
    ...context.immutableSearchTokens,
    ...context.immutableTextRequirements,
  ];
  const selected: string[] = [];
  const choices: string[] = [];

  for (const group of groups) {
    const matches =
      group.options.length === 1
        ? group.options
        : group.options.filter((option) =>
            optionMatchesRequirements(option, requirements)
          );
    if (matches.length === 1) {
      selected.push(
        group.name ? `${group.name}: ${matches[0]}` : matches[0]!
      );
      continue;
    }
    choices.push(
      group.name
        ? `${group.name}: ${group.options.join(" / ")}`
        : group.options.join(" / ")
    );
  }

  return {
    selectedVariant: selected.length > 0 ? selected.join(" · ") : null,
    requiresHumanChoice: choices.length > 0,
    choices,
  };
}

