/** Merge editor tab input; kept apart from `MergeEditor` so opening one does not load it. */
import type { EditorInput } from "@/workbench/contributions";

export const MERGE_KIND = "merge";

export interface MergeData {
  path: string;
  autoAgent?: boolean;
}

export function mergeInput(path: string, opts?: { autoAgent?: boolean }): EditorInput {
  return {
    kind: MERGE_KIND,
    key: `merge:${path}`,
    path,
    data: { path, ...(opts?.autoAgent ? { autoAgent: true } : {}) } satisfies MergeData,
  };
}
