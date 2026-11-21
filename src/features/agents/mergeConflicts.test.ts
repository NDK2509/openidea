import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigOption, AgentProvider, AgentTask } from "@/bindings";
import {
  registerMergeAgentTarget,
  type MergeAgentProgress,
  type MergeAgentSnapshot,
  type MergeAgentTarget,
} from "@/workbench/contributions";
import {
  cancelMergeConflicts,
  hunkExpectsTrailingNewline,
  mergeConflictsPrompt,
  mergeConflictsWithAgent,
  parseMergeResolutions,
} from "./mergeConflicts";
import { useAgents, type Draft } from "./store";

const backend = vi.hoisted(() => ({
  create: vi.fn(),
  entries: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    agentCreate: backend.create,
    agentEntries: backend.entries,
    agentCancel: backend.cancel,
    agentDelete: backend.remove,
  },
}));

vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: backend.notify }),
}));

const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });

const task = (id: string, provider: string, patch: Partial<AgentTask> = {}): AgentTask => ({
  id,
  title: id,
  provider,
  model: null,
  status: "ready",
  isolation: "local",
  cwd: "/p",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [],
  commands: [],
  usage: null,
  queue: [],
  ...patch,
});

const modelOption = (current: string | null): AgentConfigOption => ({
  id: "model",
  name: "Model",
  description: null,
  category: "model",
  current,
  values: ["fast", "smart"].map((value) => ({ value, name: value, description: null })),
  via: "option",
});

const provider = (id: string, installed = true, config: AgentConfigOption[] = []) =>
  ({ id, name: id === "claude" ? "Claude Code" : id, installed, config }) as AgentProvider;

const draft = (id: string): Draft => ({ provider: id, config: {}, isolation: "local", base: null });

const SNAPSHOT: MergeAgentSnapshot = {
  revision: 5,
  path: "/p/src/service.ts",
  leftLabel: "Changes from feature/auth",
  rightLabel: "Changes from main",
  resultText: "import a from 'a';\nconst x = 0;\n",
  hunks: [
    {
      index: 0,
      kind: "conflict",
      base: "const x = 0;\n",
      left: "const x = 1;\n",
      right: "const x = 2;\n",
      current: "const x = 0;\n",
      startLine: 2,
      endLine: 2,
      contextBefore: "import a from 'a';\n",
      contextAfter: "export default x;",
    },
  ],
};

describe("mergeConflictsPrompt", () => {
  it("formats 3-way hunk context and labels", () => {
    const prompt = mergeConflictsPrompt(SNAPSHOT);
    expect(prompt).toContain("Resolve merge conflicts");
    expect(prompt).toContain("File: /p/src/service.ts");
    expect(prompt).toContain("Left side (yours): Changes from feature/auth");
    expect(prompt).toContain("Right side (theirs): Changes from main");
    expect(prompt).toContain('<hunk id="0" lines="2-2" kind="conflict">');
    expect(prompt).toContain("<base>\nconst x = 0;\n</base>");
    expect(prompt).toContain("<left>\nconst x = 1;\n</left>");
    expect(prompt).toContain("<right>\nconst x = 2;\n</right>");
    expect(prompt).toContain("<context_before>");
  });

  it("trims distant context lines when exceeding the character budget", () => {
    const bigCtx = Array.from({ length: 40 }, (_, i) => `// line ${i} ${"x".repeat(40)}`).join("\n") + "\n";
    const bigSnapshot: MergeAgentSnapshot = {
      ...SNAPSHOT,
      hunks: [{ ...SNAPSHOT.hunks[0]!, contextBefore: bigCtx, contextAfter: bigCtx }],
    };
    const prompt = mergeConflictsPrompt(bigSnapshot, 1200);
    expect(prompt).toContain("<base>\nconst x = 0;\n</base>");
    expect(prompt).not.toContain("// line 0 ");
  });
});

describe("parseMergeResolutions", () => {
  it("parses multiple <resolved> blocks while preserving indentation and trailing newlines", () => {
    const hunks = [
      { index: 0, base: "  a();\n", left: "  a1();\n", right: "  a2();\n", current: "  a();\n" },
      { index: 2, base: "  b();\n", left: "  b1();\n", right: "  b2();\n", current: "  b();\n" },
    ];
    const reply = [
      '<resolved id="0">',
      "  a1();",
      "  a2();",
      "</resolved>",
      "",
      '<resolved id="2">',
      "```ts",
      "  b1(b2());",
      "```",
      "</resolved>",
      "<summary>Combined calls from both branches.</summary>",
    ].join("\n");

    const parsed = parseMergeResolutions(reply, hunks);
    expect(parsed.summary).toBe("Combined calls from both branches.");
    expect(parsed.resolutions.get(0)).toBe("  a1();\n  a2();\n");
    expect(parsed.resolutions.get(2)).toBe("  b1(b2());\n");
  });

  it("handles empty deletions and hunks without a trailing newline", () => {
    const hunks = [
      { index: 0, base: "old\n", left: "", right: "", current: "old\n" },
      { index: 1, base: "tail", left: "leftTail", right: "rightTail", current: "tail" },
    ];
    expect(hunkExpectsTrailingNewline(hunks[1]!)).toBe(false);
    const reply = '<resolved id="0">\n</resolved>\n<resolved id="1">\ncombinedTail\n</resolved>';
    const parsed = parseMergeResolutions(reply, hunks);
    expect(parsed.resolutions.get(0)).toBe("");
    expect(parsed.resolutions.get(1)).toBe("combinedTail");
  });

  it("falls back to a single fenced block when one hunk was requested", () => {
    const parsed = parseMergeResolutions("Here is the fix:\n```ts\nconst x = 3;\n```\n", SNAPSHOT.hunks);
    expect(parsed.resolutions.get(0)).toBe("const x = 3;\n");
  });

  it("rejects replies that still contain conflict markers", () => {
    const bad = '<resolved id="0">\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n</resolved>';
    expect(() => parseMergeResolutions(bad, SNAPSHOT.hunks)).toThrow(/conflict markers/);
  });
});

describe("mergeConflictsWithAgent", () => {
  const notified = () => backend.notify.mock.calls.map(([n]) => n as { level: string; title: string; body?: string });
  let progressLog: MergeAgentProgress[];
  let applySpy: ReturnType<typeof vi.fn<MergeAgentTarget["applyResolutions"]>>;
  let snapshotValue: MergeAgentSnapshot | null;
  let disposeTarget: () => void;

  function createdTask(
    status: AgentTask["status"],
    reply = '<resolved id="0">\nconst x = 3;\n</resolved>\n<summary>Merged x.</summary>',
  ) {
    backend.create.mockImplementation((request: { provider: string }) => {
      setTimeout(() => {
        useAgents.setState((s) => ({ tasks: new Map(s.tasks).set("m1", task("m1", request.provider, { status })) }));
      }, 0);
      return ok(task("m1", request.provider, { status: "starting" }));
    });
    backend.entries.mockImplementation(() =>
      ok([
        { type: "user", text: "q", attachments: [] },
        { type: "agent", text: reply },
      ]),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    progressLog = [];
    snapshotValue = SNAPSHOT;
    applySpy = vi.fn<MergeAgentTarget["applyResolutions"]>(() => 1);
    backend.cancel.mockImplementation(() => ok(null));
    backend.remove.mockImplementation(() => ok(null));
    useAgents.setState({
      providers: [provider("claude")],
      tasks: new Map([["t1", task("t1", "claude", { updatedMs: 5, config: [modelOption("smart")] })]]),
      unread: new Set(),
      draft: draft("claude"),
    });
    disposeTarget?.();
    disposeTarget = registerMergeAgentTarget({
      key: "merge:/p/src/service.ts",
      snapshot: () => snapshotValue,
      applyResolutions: applySpy,
      setProgress: (p) => progressLog.push(p),
      undo: vi.fn(),
    });
  });

  it("asks the agent, applies resolutions atomically, updates progress, and cleans up the quiet task", async () => {
    createdTask("ready");
    await mergeConflictsWithAgent({ key: "merge:/p/src/service.ts" });

    expect(backend.create).toHaveBeenCalledOnce();
    expect(applySpy).toHaveBeenCalledWith(5, new Map([[0, "const x = 3;\n"]]), { applyNonConflicting: true });
    expect(progressLog).toEqual([
      { state: "running", providerName: "Claude Code", hunkCount: 1 },
      { state: "done", providerName: "Claude Code", hunkCount: 1, summary: "Merged x." },
    ]);
    expect(backend.remove).toHaveBeenCalledWith("m1", false);
    expect(notified()).toEqual([]);
  });

  it("applies non-conflicting changes immediately when no conflicts remain", async () => {
    snapshotValue = { ...SNAPSHOT, hunks: [] };
    applySpy.mockReturnValue(2);
    await mergeConflictsWithAgent({ key: "merge:/p/src/service.ts" });
    expect(backend.create).not.toHaveBeenCalled();
    expect(applySpy).toHaveBeenCalledWith(5, new Map(), { applyNonConflicting: true });
    expect(progressLog).toEqual([
      { state: "done", hunkCount: 2, summary: "Applied non-conflicting changes automatically." },
    ]);
  });

  it("warns and points to settings when no agent is installed", async () => {
    useAgents.setState({ providers: [], tasks: new Map() });
    await mergeConflictsWithAgent({ key: "merge:/p/src/service.ts" });
    expect(backend.create).not.toHaveBeenCalled();
    expect(notified()).toEqual([expect.objectContaining({ level: "warning", title: "No coding agent available" })]);
    expect(progressLog.at(-1)).toEqual({ state: "idle" });
  });

  it("does not overwrite edits made while the agent was working", async () => {
    createdTask("ready");
    applySpy.mockReturnValue(0);
    await mergeConflictsWithAgent({ key: "merge:/p/src/service.ts" });
    expect(progressLog.at(-1)).toMatchObject({ state: "error" });
    expect(notified()).toEqual([expect.objectContaining({ level: "info", title: "Agent merge not applied" })]);
  });

  it("cancels an in-flight merge cleanly and removes the ephemeral task", async () => {
    backend.create.mockImplementation((request: { provider: string }) =>
      ok(task("m1", request.provider, { status: "running" })),
    );
    const pending = mergeConflictsWithAgent({ key: "merge:/p/src/service.ts" });
    await vi.waitFor(() => expect(backend.create).toHaveBeenCalledOnce());
    cancelMergeConflicts("merge:/p/src/service.ts");
    await pending;
    expect(applySpy).not.toHaveBeenCalled();
    expect(backend.cancel).toHaveBeenCalledWith("m1", null);
    expect(backend.remove).toHaveBeenCalledWith("m1", false);
    expect(progressLog.at(-1)).toEqual({ state: "idle" });
  });
});
