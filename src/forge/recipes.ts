// Code the local model wrote that passed its live tests and cross-check, kept so
// the next request for the same kind of skill is tested and answered in seconds
// instead of written again. Reused code is still tested live on the new request,
// cross-checked, and installed only with the user's OK; if it fails, the model
// writes new code as usual.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface Recipe {
  /** The source's general tool name, or source.name(inputs) for a skill the model designed. */
  key: string;
  code: string;
  /** The request it was first written and verified for. */
  request: string;
  savedAt: string;
  /** The rules it passed under (source notes and checks); a recipe from older rules is not reused. */
  version: string;
}

const dir = () => path.join(config.dataDir, "recipes");
const file = (key: string) => path.join(dir(), `${key.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 120)}.json`);

export function recipeKey(sourceId: string, general: boolean, name: string, inputs: string[]): string {
  return general ? name : `${sourceId}.${name}(${[...inputs].sort().join(",")})`;
}

export function loadRecipe(key: string, version: string): Recipe | undefined {
  if (!config.recipes) return undefined;
  try {
    const r = JSON.parse(readFileSync(file(key), "utf8")) as Recipe;
    return r.key === key && r.version === version && typeof r.code === "string" ? r : undefined;
  } catch {
    return undefined;
  }
}

export function saveRecipe(key: string, code: string, request: string, version: string): void {
  if (!config.recipes) return;
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(key), JSON.stringify({ key, code, request, savedAt: new Date().toISOString(), version } satisfies Recipe, null, 2));
}

/** Saved skills the model designed itself (not a source's general tool), so it can reuse a name that fits. */
export function designedRecipes(): Recipe[] {
  if (!config.recipes) return [];
  try {
    return readdirSync(dir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(dir(), f), "utf8")) as Recipe)
      .filter((r) => r.key.includes("."));
  } catch {
    return [];
  }
}
