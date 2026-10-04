import { TIERS, type Candidate, type EligibilityResult, type Tier } from "./types";

export function decide(prompt: string, choice: string | undefined, confidence: number | undefined, current: Tier, candidates: Candidate[], minConfidence: number) {
  const available = candidates.map(candidate => candidate.tier);
  const rank = (tier: Tier) => TIERS.indexOf(tier);
  const finish = (tier: Tier, reason: string) => ({ tier, reason: tier === current ? `${reason}/no-change` : reason });
  const override = prompt.match(/^\s*(?:please\s+)?(?:use|switch to|with)\s+(fast|balanced|strong|long|luna|sol|astra)\b/i)?.[1].toLowerCase();
  const aliases: Record<string, Tier> = { luna: "fast", sol: "strong", astra: "long" };
  if (override) {
    const tier = aliases[override] ?? override as Tier;
    return finish(available.includes(tier) ? tier : current, available.includes(tier) ? "override" : "override+unavailable");
  }
  if (!choice || !available.includes(choice as Tier) || !Number.isFinite(confidence) || confidence! < 0 || confidence! > 1) return finish(current, "jev-unavailable");
  let target = choice as Tier;
  let reason = "jev";
  if (confidence! < minConfidence) {
    if (rank(target) < rank(current)) return finish(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(rank(current), rank("balanced"));
    if (rank(target) > ceiling) {
      const capped = TIERS[ceiling];
      if (!available.includes(capped)) return finish(current, "low-confidence-capped+unavailable");
      target = capped;
      reason = "low-confidence-capped";
    }
  }
  return finish(target, reason);
}


const DECISION_LABELS: Record<string, string> = {
  jev: "JEV",
  "jev/no-change": "JEV/no-change",
  "low-confidence-no-downgrade/no-change": "low-confidence/no-change",
  "low-confidence-capped": "low-confidence/capped",
  "low-confidence-capped/no-change": "low-confidence/capped",
  "low-confidence-capped+unavailable/no-change": "low-confidence/unavailable",
  "jev-unavailable/no-change": "JEV/unavailable",
  override: "override",
  "override/no-change": "override/no-change",
  "override+unavailable/no-change": "override/unavailable",
};
export function decisionLabel(reason: string): string {
  return DECISION_LABELS[reason] ?? reason;
}

export function checkEligibility(candidates: Candidate[], requiredContext: number, reservedOutput: number): EligibilityResult {
  const eligible: Candidate[] = [];
  const rejected: { candidate: Candidate; reason: string }[] = [];
  const unknown: Candidate[] = [];
  for (const candidate of candidates) {
    const cap = candidate.capacity;
    if (!cap?.contextWindow) {
      unknown.push(candidate);
      continue;
    }
    const outputReserve = cap.outputBudget ?? reservedOutput;
    const usable = cap.contextWindow - outputReserve;
    if (requiredContext > usable) {
      rejected.push({ candidate, reason: `requires ${requiredContext} context tokens + ${outputReserve} output reserve; candidate capacity is ${cap.contextWindow} (usable ${usable})` });
    } else {
      eligible.push(candidate);
    }
  }
  return { eligible, rejected, unknown };
}
