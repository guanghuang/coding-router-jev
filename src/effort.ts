import { userAnchors } from "./context";
import type { CodexBody } from "./types";

export type EffortState = { base?: string; effort?: string; updates: { anchor: string; effort: string }[] };
export function applyEffort(body: CodexBody, state: EffortState, model: string, effort: string | undefined, anchor?: string): boolean {
  if (!effort) return false;
  const input = Array.isArray(body.input) ? body.input : typeof body.input === "string" ? [{ role: "user", content: body.input }] : [];
  const anchors = userAnchors(input);
  const missingHistory = !body.previous_response_id && state.updates.some(update => ![...anchors.values()].includes(update.anchor));
  const supportsUpdates = /^(?:gpt|chatgpt)-6(?:[.-]|$)/i.test(model) && !body.context_management && body.truncation !== "auto";
  if (!state.base || missingHistory || !supportsUpdates) {
    state.base = effort;
    state.effort = effort;
    state.updates = [];
  } else if (state.effort !== effort) {
    if (anchor) state.updates.push({ anchor, effort });
    state.effort = effort;
  }
  body.reasoning = { ...body.reasoning, effort: state.base };
  if (!supportsUpdates) return false;
  const replay = body.previous_response_id ? state.updates.filter(update => update.anchor === anchor) : state.updates;
  body.input = input.flatMap((item, index) => {
    const update = replay.findLast(update => update.anchor === anchors.get(index));
    if (!update) return [item];
    const prior = input[index - 1];
    // Avoid adjacent configuration updates, which the provider rejects.
    if (prior?.type === "configuration_update") {
      prior.reasoning = { effort: update.effort };
      return [item];
    }
    return [{ type: "configuration_update", reasoning: { effort: update.effort } }, item];
  });
  return state.updates.length > 0;
}
