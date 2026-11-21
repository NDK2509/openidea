/**
 * Merge Conflicts with Agent: sends unresolved merge hunks (with base, yours,
 * theirs and surrounding file context) to the coding agent in a quiet ephemeral
 * task, parses the per-hunk resolutions, and applies them atomically to the
 * merge editor's Result pane.
 */
import type { AgentTask } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import {
  mergeAgentTarget,
  notifications,
  type MergeAgentHunk,
  type MergeAgentSnapshot,
  type NotificationService,
} from "@/workbench/contributions";
import { pickAgent, replyOf } from "./commitMessage";
import { isBusy, REGISTRY_PAGE } from "./model";
import { cancelTask, deleteTask, runQuietly, useAgents } from "./store";

const MERGE_BUDGET = 60_000;
const TIMEOUT_MS = 180_000;
const NOTIFICATION_KEY = "agents.mergeConflicts";
const CONFLICT_MARKER_RE = /^(?:<{7}|={7}|>{7})(?:\s|$)/m;

const inFlight = new Map<string, { abort: () => void }>();

function notify(n: Omit<Parameters<NotificationService["notify"]>[0], "key" | "group" | "userInitiated">) {
  notifications().notify({ ...n, key: NOTIFICATION_KEY, group: "vcs", userInitiated: true });
}

function trimLinesHead(text: string, maxLines: number): string {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}

function trimLinesTail(text: string, maxLines: number): string {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n");
}

function formatHunk(h: MergeAgentHunk, contextBefore: string, contextAfter: string): string {
  const parts = [`<hunk id="${h.index}" lines="${h.startLine}-${h.endLine}" kind="${h.kind}">`];
  if (contextBefore) parts.push(`<context_before>\n${contextBefore.replace(/\n$/, "")}\n</context_before>`);
  parts.push(
    `<base>\n${h.base.replace(/\n$/, "")}\n</base>`,
    `<left>\n${h.left.replace(/\n$/, "")}\n</left>`,
    `<right>\n${h.right.replace(/\n$/, "")}\n</right>`,
    `<current>\n${h.current.replace(/\n$/, "")}\n</current>`,
  );
  if (contextAfter) parts.push(`<context_after>\n${contextAfter.replace(/\n$/, "")}\n</context_after>`);
  parts.push("</hunk>");
  return parts.join("\n");
}

/** Builds the 3-way conflict resolution prompt within `budget` characters. */
export function mergeConflictsPrompt(snapshot: MergeAgentSnapshot, budget = MERGE_BUDGET): string {
  const header = [
    "Resolve merge conflicts",
    "",
    `File: ${snapshot.path}`,
    `Left side (yours): ${snapshot.leftLabel}`,
    `Right side (theirs): ${snapshot.rightLabel}`,
    "",
    "Instructions:",
    "- Resolve each <hunk> below by combining both sides' changes cleanly where compatible, preserving valid syntax, imports, and types.",
    "- If both sides made incompatible edits to the same logic, reconcile them carefully so the resulting code is coherent and complete.",
    "- Never include git conflict markers (<<<<<<<, =======, >>>>>>>).",
    "- Don't edit files on disk or run commands. All relevant code and context are below.",
    '- Reply ONLY with one <resolved id="N">...</resolved> block per requested hunk id (preserving exact indentation), followed by a brief one-sentence <summary>...</summary>.',
    '- If a hunk should be deleted completely, output an empty <resolved id="N"></resolved>.',
    "",
  ].join("\n");

  const render = (maxContextLines: number) =>
    header +
    snapshot.hunks
      .map((h) =>
        formatHunk(
          h,
          maxContextLines === Infinity ? h.contextBefore : trimLinesHead(h.contextBefore, maxContextLines),
          maxContextLines === Infinity ? h.contextAfter : trimLinesTail(h.contextAfter, maxContextLines),
        ),
      )
      .join("\n\n");

  for (const limit of [Infinity, 12, 4, 0]) {
    const prompt = render(limit);
    if (prompt.length <= budget || limit === 0) return prompt;
  }
  return render(0);
}

/** Whether a hunk spans complete lines ending with a line break. */
export function hunkExpectsTrailingNewline(h: Pick<MergeAgentHunk, "base" | "left" | "right" | "current">): boolean {
  if (h.current) return h.current.endsWith("\n");
  return (h.left || h.base || h.right).endsWith("\n");
}

function unwrapSingleFence(text: string): string {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1]! : text;
}

function normalizeResolutionText(raw: string, expectsNewline: boolean): string {
  let text = raw.replace(/\r\n?/g, "\n");
  if (text.startsWith("\n")) text = text.slice(1);
  if (text === "") return "";
  const unfenced = unwrapSingleFence(text);
  if (unfenced !== text) text = unfenced;
  if (text === "") return "";
  if (expectsNewline) {
    if (!text.endsWith("\n")) text += "\n";
  } else if (text.endsWith("\n")) {
    text = text.slice(0, -1);
  }
  return text;
}

/**
 * Parses `<resolved id="N">...</resolved>` blocks and optional `<summary>...</summary>`
 * from an agent's reply. Supports a single fenced code block fallback when only one hunk
 * was requested.
 */
export function parseMergeResolutions(
  reply: string,
  hunks: readonly Pick<MergeAgentHunk, "index" | "base" | "left" | "right" | "current">[],
): { resolutions: Map<number, string>; summary: string } {
  const normalized = reply.replace(/\r\n?/g, "\n");
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(normalized);
  const summary = summaryMatch ? summaryMatch[1]!.replace(/\s+/g, " ").trim() : "";

  const byId = new Map(hunks.map((h) => [h.index, h]));
  const resolutions = new Map<number, string>();
  const tagRe = /<resolved\s+id=["']?(\d+)["']?\s*>([\s\S]*?)<\/resolved>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(normalized)) !== null) {
    const id = Number(m[1]);
    const hunk = byId.get(id);
    if (!hunk) continue;
    const text = normalizeResolutionText(m[2]!, hunkExpectsTrailingNewline(hunk));
    if (CONFLICT_MARKER_RE.test(text)) {
      throw new Error(tx("The agent reply still contained conflict markers"));
    }
    resolutions.set(id, text);
  }

  if (resolutions.size === 0 && hunks.length === 1) {
    const fenced = /```[^\n]*\n([\s\S]*?)\n?```/.exec(normalized);
    if (fenced) {
      const hunk = hunks[0]!;
      const text = normalizeResolutionText(fenced[1]!, hunkExpectsTrailingNewline(hunk));
      if (CONFLICT_MARKER_RE.test(text)) {
        throw new Error(tx("The agent reply still contained conflict markers"));
      }
      resolutions.set(hunk.index, text);
    }
  }

  return { resolutions, summary };
}

function waitForTurn(taskId: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const off = useAgents.subscribe(check);
    const timer = setTimeout(() => settle(tx("The agent did not answer in time")), TIMEOUT_MS);
    const onAbort = () => settle("ABORTED");
    signal.addEventListener("abort", onAbort, { once: true });

    function settle(error?: string) {
      off();
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else if (error === "ABORTED") reject(new DOMException("Aborted", "AbortError"));
      else reject(new Error(error));
    }

    function check() {
      const current = useAgents.getState().tasks.get(taskId);
      if (!current) return settle(tx("The agent task was removed"));
      switch (current.status) {
        case "ready":
          return settle();
        case "failed":
          return settle(current.error ?? tx("The agent stopped"));
        case "limited":
          return settle(tx("The agent's usage limit was reached"));
        case "needsInput":
          return settle(tx("The agent asked for permission to continue"));
        case "archived":
          return settle(tx("The agent task was archived"));
      }
    }
    check();
  });
}

/** Cancels an in-flight agent merge for `key` (or the active merge editor). */
export function cancelMergeConflicts(key?: string): void {
  const target = mergeAgentTarget(key);
  const targetKey = key ?? target?.key;
  if (targetKey) inFlight.get(targetKey)?.abort();
  target?.setProgress({ state: "idle" });
}

/** Asks the coding agent to resolve conflicts in the active (or targeted) merge editor. */
export async function mergeConflictsWithAgent(arg?: { key?: string; indexes?: number[] }): Promise<void> {
  const target = mergeAgentTarget(arg?.key);
  if (!target) return;
  if (inFlight.has(target.key)) return;

  const snapshot = target.snapshot(arg?.indexes);
  if (!snapshot) return;

  if (snapshot.hunks.length === 0) {
    if (!arg?.indexes) {
      const applied = target.applyResolutions(snapshot.revision, new Map(), { applyNonConflicting: true });
      if (applied > 0) {
        target.setProgress({
          state: "done",
          hunkCount: applied,
          summary: tx("Applied non-conflicting changes automatically."),
        });
        return;
      }
    }
    notify({ level: "info", title: "No unresolved conflicts to merge" });
    return;
  }

  const { commit } = workflowSettings().vcs;
  const { tasks, providers, draft, modelCatalogs } = useAgents.getState();
  const agent = pickAgent(tasks.values(), providers, draft, commit, modelCatalogs);
  if (!agent) {
    notify({
      level: "warning",
      title: "No coding agent available",
      body: "Set one up in Settings › Agents. Agents don't run in projects you haven't trusted.",
      actions: [{ label: "Open Settings", run: () => void executeAction("file.settings", REGISTRY_PAGE) }],
    });
    target.setProgress({ state: "idle" });
    return;
  }

  const providerName = providers.find((p) => p.id === agent.provider)?.name ?? agent.provider;
  const controller = new AbortController();
  inFlight.set(target.key, { abort: () => controller.abort() });
  target.setProgress({
    state: "running",
    providerName,
    hunkCount: snapshot.hunks.length,
  });

  const prompt = mergeConflictsPrompt(snapshot);
  let task: AgentTask | undefined;
  let release = () => {};
  try {
    const created = await call(
      commands.agentCreate({
        projectRoot: null,
        prompt: { text: prompt, files: [], images: [] },
        provider: agent.provider,
        config: agent.config,
        isolation: "local",
        base: null,
      }),
    );
    task = created;
    release = runQuietly(created.id);
    useAgents.setState((s) => ({
      tasks: s.tasks.has(created.id) ? s.tasks : new Map(s.tasks).set(created.id, created),
    }));
    if (controller.signal.aborted) return;

    await waitForTurn(created.id, controller.signal);
    if (controller.signal.aborted) return;

    const reply = replyOf(await call(commands.agentEntries(created.id, null)));
    if (controller.signal.aborted) return;

    const { resolutions, summary } = parseMergeResolutions(reply, snapshot.hunks);
    if (resolutions.size === 0) {
      throw new Error(tx("The agent did not return any conflict resolutions"));
    }

    const applied = target.applyResolutions(snapshot.revision, resolutions, {
      applyNonConflicting: !arg?.indexes,
    });
    if (applied === 0) {
      target.setProgress({
        state: "error",
        providerName,
        error: tx("Merge result was edited meanwhile; agent changes were not applied."),
      });
      notify({
        level: "info",
        title: "Agent merge not applied",
        body: "The merge result was edited while the agent worked.",
      });
      return;
    }
    target.setProgress({
      state: "done",
      providerName,
      hunkCount: applied,
      summary: summary || undefined,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      target.setProgress({ state: "idle" });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    target.setProgress({ state: "error", providerName, error: message });
    notify({
      level: "error",
      title: "Couldn't merge conflicts with agent",
      body: message,
    });
  } finally {
    inFlight.delete(target.key);
    if (task) {
      const status = useAgents.getState().tasks.get(task.id)?.status;
      if (status && isBusy(status)) await cancelTask(task.id).catch(() => {});
      await deleteTask(task.id, false).catch(() => {});
    }
    release();
  }
}
