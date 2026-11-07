// The SOP file, sop/default.yml (spec §6 "SOP", plan Task 9). Task 14 writes the file and the engine that runs it.
import YAML from "yaml";

/** The Phase 0 stages: the prompts plan Task 14 lists, plus sign-off, which no cell runs. */
export const STAGE_IDS = ["understand", "specify", "sign-off", "red", "green", "self-review", "open-pr", "address"] as const;
export type StageId = (typeof STAGE_IDS)[number];

export type SopStage = { id: StageId; model?: string } & Record<string, unknown>;
export type Sop = {
  sop: string;
  version: string;
  models: { coding: string; triage: string } & Record<string, string>;
  stages: SopStage[];
};

export class SopError extends Error {
  override name = "SopError";
}

/** Parses and validates an SOP: known, unique stage ids, both required models, and stage models that name one. */
export function loadSop(yamlText: string): Sop {
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch (e) {
    throw new SopError(`not valid YAML: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== "object") throw new SopError("the SOP is empty");
  const d = doc as Record<string, unknown>;
  if (typeof d.sop !== "string" || typeof d.version !== "string") throw new SopError("the SOP needs a name and a version");

  const models = d.models as Record<string, unknown> | undefined;
  if (!models || typeof models !== "object") throw new SopError("the SOP has no models");
  for (const [key, id] of Object.entries(models)) if (typeof id !== "string") throw new SopError(`models.${key} must be a model id`);
  for (const key of ["coding", "triage"]) if (!(key in models)) throw new SopError(`models.${key} is missing`);

  if (!Array.isArray(d.stages) || d.stages.length === 0) throw new SopError("the SOP has no stages");
  const seen = new Set<string>();
  for (const stage of d.stages as Record<string, unknown>[]) {
    const id = stage?.id;
    if (typeof id !== "string" || !(STAGE_IDS as readonly string[]).includes(id)) throw new SopError(`unknown stage id ${String(id)}`);
    if (seen.has(id)) throw new SopError(`stage ${id} appears twice`);
    seen.add(id);
    if (stage.model !== undefined && !(typeof stage.model === "string" && Object.hasOwn(models, stage.model))) {
      throw new SopError(`stage ${id} names model ${String(stage.model)}, which isn't in models`);
    }
  }
  return d as unknown as Sop;
}

/**
 * Where a run resumes after `stageId` passes (Run contract 1, issue #97): the next stage the SOP lists. Open-pr and
 * address hand the item back through pr_opened, and the merge pass isn't an SOP stage, so those, and any stage the
 * SOP doesn't list, give null and leave the resume pointer where it was.
 */
export function stageAfter(sop: Sop, stageId: string): string | null {
  if (stageId === "open-pr" || stageId === "address") return null;
  const ids: string[] = sop.stages.map((s) => s.id);
  const i = ids.indexOf(stageId);
  return i < 0 ? null : ids[i + 1] ?? null;
}
