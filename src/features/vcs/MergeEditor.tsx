/** Three-pane merge editor: Yours | Result | Theirs, after IntelliJ's merge tool. */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { Compartment, Transaction, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap, undo, undoDepth } from "@codemirror/commands";
import type { MergeSides } from "@/bindings";
import { embeddedEditorExtensions } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { tx, useTxTemplate } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { readClipboardPlainText } from "@/platform/clipboard";
import { copyText } from "@/ui/selectableText";
import { Button, Icon, IconButton, Spinner, SplitGroup, SplitHandle, SplitPanel, T } from "@/ui";
import {
  editorService,
  registerMergeAgentTarget,
  setActiveMergeAgentTarget,
  type EditorInput,
  type MergeAgentHunk,
  type MergeAgentProgress,
  type MergeAgentSnapshot,
} from "@/workbench/contributions";
import { blameSlot, toggleAnnotations } from "./blame";
import { firstLineOf, languageFor, viewerBase } from "./cm";
import type { HighlightPolicy, IgnorePolicy } from "./diffOptions";
import { confirmDialog } from "./dialogs";
import { focusedDiffNavigator, setFocusedDiffNavigator, type DiffNavigator } from "./diffNavigator";
import { mergeDividers } from "./mergeDividers";
import { syncMergeScroll } from "./mergeScroll";
import { mergeTitles } from "./conflicts";
import {
  createResultMarks,
  mergeChanged,
  mergeStripe,
  mergeTheme,
  resultControls,
  sideControls,
  sideMarks,
  syncSide,
  type MergeControls,
} from "./mergeGutters";
import { COMPARISONS, showCompareMenu, showResultMenu, showSettingsMenu, showSideMenu } from "./mergeMenus";
import { openVcsDiff } from "./diffInput";
import {
  clearFocusedMergeEditor,
  refreshMergeActions,
  setFocusedMergeEditor,
  type MergeActionHost,
  type MergeCommand,
} from "./mergeActions";
import {
  applyAgentResolutions,
  applyNonConflicting,
  applyTo,
  canApply,
  changesIn,
  changesInSide,
  isConflict,
  isResolved,
  mergeField,
  mergeHistory,
  resetChanges,
  resolveSimple,
  revertResolved,
  startMerge,
  summarize,
  unresolved,
  type MergeAction,
  type MergeSide,
  type MergeSummary,
} from "./mergeModel";
import { MergeFooter, MergeToolbar } from "./MergeToolbar";
import { baseName } from "./model";
import { errorMessage, runOp, writeFileText } from "./ops";
import { refreshNow } from "./store";
import styles from "./MergeEditor.module.css";

import type { MergeData } from "./mergeKind";
export { MERGE_KIND, mergeInput, type MergeData } from "./mergeKind";

const NOTHING_LEFT: MergeSummary = {
  pending: 0,
  conflicts: 0,
  left: false,
  all: false,
  right: false,
  simple: false,
  revert: false,
};

// IntelliJ's "Automatically apply non-conflicting changes" (Tools | Diff & Merge); off by default.
const AUTO_APPLY_KEY = "openidea.merge.autoApplyNonConflicting";
const readAutoApply = () => {
  try {
    return localStorage.getItem(AUTO_APPLY_KEY) === "true";
  } catch {
    return false;
  }
};
const writeAutoApply = (on: boolean) => {
  try {
    localStorage.setItem(AUTO_APPLY_KEY, String(on));
  } catch {
    // The choice then lasts only until the editor closes.
  }
};

/** A file without a language; one value, so finding none again doesn't rebuild the panes. */
const NO_LANGUAGE: Extension = [];
const CONTEXT_LINES = 25;

/** Highlights the branch/commit suffix of IntelliJ-style labels like `Changes from master`. */
function renderBranchLabel(text: string) {
  const m = /^(Changes from |Rebasing .+? from )(.+)$/.exec(text);
  if (!m) return text;
  return (
    <>
      {m[1]}
      <strong>{m[2]}</strong>
    </>
  );
}

export function MergeEditor({ input }: { input: EditorInput }) {
  const data = input.data as MergeData;
  const { path } = data;
  const [state, setState] = useState<{
    ours: string;
    theirs: string;
    base: string | null;
    sides: MergeSides;
    deleted: Record<MergeSide, boolean>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<Extension | null>(null);
  const [summary, setSummary] = useState<MergeSummary>(NOTHING_LEFT);
  const [autoApply, setAutoApply] = useState(readAutoApply);
  const [ignore, setIgnore] = useState<IgnorePolicy>("none");
  const [highlight, setHighlight] = useState<HighlightPolicy>("words");
  const [syncScroll, setSyncScroll] = useState(true);
  const [agentProgress, setAgentProgress] = useState<MergeAgentProgress>({ state: "idle" });
  const [resolved, setResolved] = useState(false);
  const paneId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<MergeSide | "result">("result");
  const [actionHost] = useState<MergeActionHost>(() => ({
    enabled: () => false,
    run: () => {},
    autoApply: () => false,
    syncScroll: () => true,
  }));
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const leftDividerRef = useRef<HTMLDivElement>(null);
  const rightDividerRef = useRef<HTMLDivElement>(null);
  const resultView = useRef<EditorView | null>(null);
  const oursView = useRef<EditorView | null>(null);
  const theirsView = useRef<EditorView | null>(null);
  const slotsRef = useRef<{ ours: Compartment; theirs: Compartment; result: Compartment } | null>(null);
  const scrollStopRef = useRef<(() => void) | null>(null);
  const revisionRef = useRef(0);
  const autoApplyRef = useRef(autoApply);
  const ignoreRef = useRef(ignore);
  const lastAppliedIgnoreRef = useRef(ignore);
  const highlightRef = useRef(highlight);
  const syncScrollRef = useRef(syncScroll);
  const autoAgentTriggeredRef = useRef(false);
  useEffect(() => {
    autoApplyRef.current = autoApply;
  }, [autoApply]);
  useEffect(() => {
    ignoreRef.current = ignore;
  }, [ignore]);
  useEffect(() => {
    highlightRef.current = highlight;
  }, [highlight]);
  useEffect(() => {
    syncScrollRef.current = syncScroll;
  }, [syncScroll]);
  const txt = useTxTemplate();
  const titles = mergeTitles(state?.sides);
  const yourTitle = txt(titles.yours);
  const resultTitle = tx("Result");
  const theirTitle = txt(titles.theirs);
  const titlesRef = useRef({ yourTitle, theirTitle });
  useEffect(() => {
    titlesRef.current = { yourTitle, theirTitle };
  }, [yourTitle, theirTitle]);

  const load = useCallback(async () => {
    try {
      const v = await call(commands.vcsConflictVersions(path));
      if ([v.base, v.ours, v.theirs].some((text) => text?.includes("\0"))) {
        throw new Error(tx("Binary files cannot be resolved in the merge editor."));
      }
      setState({
        ours: v.ours ?? "",
        theirs: v.theirs ?? "",
        base: v.base,
        sides: v.sides,
        deleted: { left: v.ours === null, right: v.theirs === null },
      });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [path]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useEffect(() => {
    const buildSnapshot = (indexes?: readonly number[]): MergeAgentSnapshot | null => {
      const v = resultView.current;
      if (!v) return null;
      const doc = v.state.doc;
      const changes = v.state.field(mergeField);
      const targetIndexes = indexes
        ? indexes.filter((i) => changes[i] && !isResolved(changes[i]!))
        : changes.flatMap((c, i) => (isConflict(c) && !isResolved(c) ? [i] : []));
      const hunks: MergeAgentHunk[] = targetIndexes.map((index) => {
        const c = changes[index]!;
        const startLineObj = doc.lineAt(Math.min(c.from, doc.length));
        const endPos = c.to > c.from ? Math.max(c.from, c.to - 1) : c.from;
        const endLineObj = doc.lineAt(Math.min(endPos, doc.length));
        const ctxBeforeStart = Math.max(1, startLineObj.number - CONTEXT_LINES);
        const ctxAfterEnd = Math.min(doc.lines, endLineObj.number + CONTEXT_LINES);
        const contextBefore =
          startLineObj.number > 1 ? doc.sliceString(doc.line(ctxBeforeStart).from, startLineObj.from) : "";
        const contextAfter =
          endLineObj.number < doc.lines
            ? doc.sliceString(doc.line(endLineObj.number + 1).from, doc.line(ctxAfterEnd).to)
            : "";
        return {
          index,
          kind: c.kind,
          base: c.base,
          left: c.left,
          right: c.right,
          current: doc.sliceString(c.from, c.to),
          startLine: startLineObj.number,
          endLine: endLineObj.number,
          contextBefore,
          contextAfter,
        };
      });
      return {
        revision: revisionRef.current,
        path,
        leftLabel: titlesRef.current.yourTitle,
        rightLabel: titlesRef.current.theirTitle,
        resultText: doc.toString(),
        hunks,
      };
    };

    const dispose = registerMergeAgentTarget({
      key: input.key,
      snapshot: buildSnapshot,
      applyResolutions(revision, resolutions, opts) {
        const v = resultView.current;
        if (!v || revision !== revisionRef.current) return 0;
        const { spec, applied } = applyAgentResolutions(v.state, resolutions, opts);
        if (!spec || applied === 0) return 0;
        v.dispatch(spec);
        return applied;
      },
      setProgress: setAgentProgress,
      undo: () => {
        const v = resultView.current;
        if (!v) return;
        undo(v);
        v.focus();
      },
    });
    return () => {
      void executeAction("agents.cancelMergeConflicts", { key: input.key });
      dispose();
    };
  }, [input.key, path]);

  // From a side's first line (hashbang-only scripts): the file on disk may start with a conflict marker.
  const firstLine = state ? firstLineOf(state.ours || state.theirs) : undefined;
  useEffect(() => {
    if (firstLine === undefined) return;
    let alive = true;
    void languageFor(path, firstLine).then((l) => alive && setLang(() => l ?? NO_LANGUAGE));
    return () => {
      alive = false;
    };
  }, [path, firstLine]);

  useEffect(() => {
    if (!state || lang === null || !oursRef.current || !resultRef.current || !theirsRef.current) return;
    // Like IntelliJ, the result starts as the base, with every change waiting to be decided.
    const start = startMerge(state.ours, state.base ?? "", state.theirs, ignoreRef.current);
    lastAppliedIgnoreRef.current = ignoreRef.current;
    revisionRef.current = 0;
    const slots = {
      ours: new Compartment(),
      theirs: new Compartment(),
      result: new Compartment(),
    };
    slotsRef.current = slots;

    const change = (index: number, action: MergeAction) => {
      setFocusedMergeEditor(actionHost);
      setActiveMergeAgentTarget(input.key);
      void executeAction("merge.change", { indexes: [index], action });
    };
    const controls: MergeControls = {
      accept: (index, side, resolve) => change(index, { type: "accept", side, resolve }),
      ignore: (index, side, resolve) => change(index, { type: "ignore", side: resolve ? null : side }),
      resolveAutomatically: (index) => change(index, { type: "auto", side: "base" }),
      resolveWithAgent: (index) => {
        setFocusedMergeEditor(actionHost);
        setActiveMergeAgentTarget(input.key);
        void executeAction("agents.mergeConflicts", { key: input.key, indexes: [index] });
      },
    };
    const sideBase = (which: MergeSide): Extension[] => [
      lang,
      blameSlot(),
      EditorView.updateListener.of((u) => {
        if (u.selectionSet) refreshMergeActions(actionHost);
      }),
      slots[which === "left" ? "ours" : "theirs"].of(sideMarks(which, highlightRef.current, ignoreRef.current)),
      mergeStripe(which),
      mergeTheme,
    ];
    // Left gutter faces Result on the right edge ([code][× >>][line#]); Right faces Result on the left ([line#][<< ×][code]).
    const ours = new EditorView({
      doc: state.ours,
      parent: oursRef.current,
      extensions: [
        sideControls("left", controls),
        viewerBase({ readOnly: true, lineNumbers: "after" }),
        ...sideBase("left"),
      ],
    });
    const theirs = new EditorView({
      doc: state.theirs,
      parent: theirsRef.current,
      extensions: [
        viewerBase({ readOnly: true, lineNumbers: true }),
        sideControls("right", controls),
        ...sideBase("right"),
      ],
    });
    const result: EditorView = new EditorView({
      doc: start.text,
      parent: resultRef.current,
      extensions: [
        viewerBase({ readOnly: false }),
        history(),
        keymap.of(historyKeymap),
        mergeField.init(() => start.changes),
        mergeHistory,
        embeddedEditorExtensions(path),
        lang,
        slots.result.of(createResultMarks(highlightRef.current)),
        mergeStripe("result"),
        resultControls(controls),
        mergeTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged || mergeChanged(u)) revisionRef.current += 1;
          if (u.selectionSet || mergeChanged(u)) refreshMergeActions(actionHost);
          if (!mergeChanged(u)) return;
          const changes = u.state.field(mergeField);
          ours.dispatch({ effects: syncSide.of(changes) });
          theirs.dispatch({ effects: syncSide.of(changes) });
          setSummary(summarize(u.state));
        }),
      ],
    });
    resultView.current = result;
    oursView.current = ours;
    theirsView.current = theirs;
    ours.dispatch({ effects: syncSide.of(start.changes) });
    theirs.dispatch({ effects: syncSide.of(start.changes) });
    setSummary(summarize(result.state));
    if (autoApplyRef.current) {
      const spec = applyNonConflicting(result.state, "base");
      // The starting point, not a step to undo.
      if (spec) result.dispatch({ ...spec, annotations: Transaction.addToHistory.of(false) });
    }
    if (syncScrollRef.current) {
      scrollStopRef.current = syncMergeScroll({ ours, result, theirs });
    }
    const left = leftDividerRef.current;
    const right = rightDividerRef.current;
    const stopDividers = left && right ? mergeDividers({ ours, result, theirs }, { left, right }) : () => {};

    if (data.autoAgent && !autoAgentTriggeredRef.current) {
      autoAgentTriggeredRef.current = true;
      queueMicrotask(() => {
        void executeAction("agents.mergeConflicts", { key: input.key });
      });
    }

    return () => {
      scrollStopRef.current?.();
      scrollStopRef.current = null;
      stopDividers();
      ours.destroy();
      theirs.destroy();
      result.destroy();
      slotsRef.current = null;
      resultView.current = null;
      oursView.current = null;
      theirsView.current = null;
    };
  }, [state, lang, path, actionHost, input.key, data.autoAgent]);

  useEffect(() => {
    const result = resultView.current;
    const ours = oursView.current;
    const theirs = theirsView.current;
    const slots = slotsRef.current;
    if (!result || !ours || !theirs || !slots) return;

    if (ignore !== lastAppliedIgnoreRef.current && state) {
      lastAppliedIgnoreRef.current = ignore;
      if (undoDepth(result.state) === 0) {
        const fresh = startMerge(state.ours, state.base ?? "", state.theirs, ignore);
        result.dispatch({
          changes: { from: 0, to: result.state.doc.length, insert: fresh.text },
          effects: resetChanges.of(fresh.changes),
          annotations: Transaction.addToHistory.of(false),
        });
        if (autoApplyRef.current) {
          const spec = applyNonConflicting(result.state, "base");
          if (spec) result.dispatch({ ...spec, annotations: Transaction.addToHistory.of(false) });
        }
      }
    }

    ours.dispatch({ effects: slots.ours.reconfigure(sideMarks("left", highlight, ignore)) });
    theirs.dispatch({ effects: slots.theirs.reconfigure(sideMarks("right", highlight, ignore)) });
    result.dispatch({ effects: slots.result.reconfigure(createResultMarks(highlight)) });
  }, [highlight, ignore, state]);

  useEffect(() => {
    scrollStopRef.current?.();
    scrollStopRef.current = null;
    if (syncScroll && oursView.current && resultView.current && theirsView.current) {
      scrollStopRef.current = syncMergeScroll({
        ours: oursView.current,
        result: resultView.current,
        theirs: theirsView.current,
      });
    }
  }, [syncScroll]);

  /**
   * Puts the caret at a change, brings it into view and focuses the pane: CodeMirror draws the
   * caret only in a focused editor, so a move made by a toolbar button would be invisible.
   */
  const moveTo = (view: EditorView, at: number) => {
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    view.focus();
  };

  const goto = (dir: 1 | -1) => {
    const v = resultView.current;
    if (!v) return;
    const open = unresolved(v.state);
    if (!open.length) return;
    const head = v.state.selection.main.head;
    const target =
      dir === 1
        ? (open.find((c) => c.from > head) ?? open[0]!)
        : ([...open].reverse().find((c) => c.from < head) ?? open[open.length - 1]!);
    moveTo(v, target.from);
  };

  /** Runs a command on the result; `reveal` then moves to what is left to decide. */
  const command = (make: (s: EditorState) => TransactionSpec | null, reveal = false) => {
    const v = resultView.current;
    const spec = v && make(v.state);
    if (!v || !spec) return;
    v.dispatch(spec);
    const first = reveal ? unresolved(v.state)[0] : undefined;
    if (first) moveTo(v, first.from);
  };

  /** Saves `text` as the resolved file and stages it; like IDEA, that closes the merge editor. */
  const writeResolved = async (text: string | null) => {
    const ok = await runOp(
      tx`Resolve ${baseName(path)}`,
      async () => {
        if (text === null) await call(commands.fsDelete(path));
        else await writeFileText(path, text, { save: true, exact: true });
        await call(commands.vcsStage([path]));
        return true;
      },
      { success: tx`${baseName(path)}: conflicts resolved` },
    );
    if (ok) {
      setResolved(true);
      await refreshNow();
      await editorService().closeInput?.(input.key);
    }
  };

  const apply = async () => {
    const v = resultView.current;
    if (!v) return;
    const remaining = unresolved(v.state).length;
    if (
      remaining > 0 &&
      !(await confirmDialog({
        title: "Unresolved Changes",
        message:
          remaining === 1
            ? tx`${remaining} change is unresolved and keeps the base text. Save and mark the file as resolved anyway?`
            : tx`${remaining} changes are unresolved and keep the base text. Save and mark the file as resolved anyway?`,
        okLabel: "Mark Resolved",
      }))
    )
      return;
    const separator = (state?.base ?? state?.ours ?? state?.theirs ?? "").includes("\r\n") ? "\r\n" : "\n";
    await writeResolved(v.state.doc.sliceString(0, undefined, separator));
  };

  /** Whether the user decided or edited anything: what Accept and Cancel ask about. */
  const modified = () => {
    const v = resultView.current;
    return !!v && undoDepth(v.state) > 0;
  };

  /** Accept Yours / Accept Theirs: that version as it is, whatever was done in the result. */
  const acceptSide = async (side: MergeSide) => {
    if (!state) return;
    if (
      modified() &&
      !(await confirmDialog({
        title: side === "left" ? "Accept Yours" : "Accept Theirs",
        message: "The result was changed. Discard the changes and take this version as it is?",
        okLabel: "Discard Changes",
        danger: true,
      }))
    )
      return;
    await writeResolved(state.deleted[side] ? null : side === "left" ? state.ours : state.theirs);
  };

  const cancel = async () => {
    if (
      modified() &&
      !(await confirmDialog({
        title: "Cancel Merge",
        message: "Exit without applying the changes made in the result?",
        okLabel: "Exit",
        danger: true,
      }))
    )
      return;
    await editorService().closeInput?.(input.key);
  };

  // Next / Previous Difference (F7 / Shift+F7 by default) jump between changes through
  // the keymap, as in the diff viewer.
  // `goto` reads only refs, so the first render's one stays valid.
  const [nav] = useState<DiffNavigator>(() => ({
    next: () => goto(1),
    prev: () => goto(-1),
    jumpToSource: () => void editorService().openFile(path, { focus: true }),
    applyChange: () => false,
    file: () => {},
    showSettings: () => void actionHost.run("settings"),
    focusOpposite: () => false,
    close: () => false,
    swapSides: () => false,
    showInExternalTool: () => false,
  }));
  useEffect(
    () => () => {
      if (focusedDiffNavigator() === nav) {
        setFocusedDiffNavigator(null);
        setContext("diffEditorFocus", false);
      }
    },
    [nav],
  );

  const setAutoApplyNonConflicting = (on: boolean) => {
    setAutoApply(on);
    writeAutoApply(on);
    if (on) command((s) => applyNonConflicting(s, "base"), true);
  };

  const activePane = () => {
    const which = paneRef.current;
    return (which === "left" ? oursView : which === "right" ? theirsView : resultView).current;
  };

  const selectionDecision = (id: MergeCommand) => {
    const view = activePane();
    const result = resultView.current;
    if (!view || !result) return null;
    const { from, to } = view.state.selection.main;
    const side = paneRef.current;
    const indexes =
      side === "result"
        ? changesIn(result.state, from, to)
        : changesInSide(result.state, side, view.state.doc, from, to);
    if (id === "resolveWithAgent") return { indexes, action: null };
    let action: MergeAction;
    if (id === "resolveAutomatically") action = { type: "auto", side: "base" };
    else if (id === "ignore") action = { type: "ignore", side: side === "result" ? null : side };
    else if (id === "resolveUsingYours" || id === "resolveUsingTheirs")
      action = { type: "accept", side: id === "resolveUsingYours" ? "left" : "right", resolve: true };
    else if (id === "accept" && side !== "result") action = { type: "accept", side, resolve: false };
    else return null;
    return { indexes, action };
  };

  const enabled = (id: MergeCommand) => {
    if (id === "reload" || id === "cancel") return !resolved;
    const v = resultView.current;
    if (!v || error || resolved) return false;
    const available = summarize(v.state);
    switch (id) {
      case "applyLeft":
        return available.left;
      case "applyAll":
        return available.all;
      case "applyRight":
        return available.right;
      case "resolveSimple":
        return available.simple;
      case "revert":
        return available.revert;
      case "resolveWithAgent": {
        if (paneRef.current !== "result") return false;
        const decision = selectionDecision(id);
        return !!decision?.indexes.some((i) => !isResolved(v.state.field(mergeField)[i]!));
      }
      case "accept":
      case "resolveUsingYours":
      case "resolveUsingTheirs":
      case "ignore":
      case "resolveAutomatically": {
        const decision = selectionDecision(id);
        return (
          !!decision?.action &&
          !!decision.indexes.some((i) => canApply(v.state.doc, v.state.field(mergeField)[i]!, decision.action!))
        );
      }
      case "annotate":
        return paneRef.current !== "result";
      case "cut":
        return paneRef.current === "result" && !v.state.selection.main.empty;
      case "copy":
        return !!activePane() && !activePane()!.state.selection.main.empty;
      case "paste":
        return paneRef.current === "result";
      default:
        return true;
    }
  };

  const menuPosition = (name: "compare" | "settings") => {
    const button = rootRef.current?.querySelector(`[data-merge-menu="${name}"]`);
    const rect = (button ?? rootRef.current)?.getBoundingClientRect();
    return { clientX: rect?.left ?? 0, clientY: rect?.bottom ?? 0 };
  };

  const runAction = async (id: MergeCommand, arg?: unknown) => {
    switch (id) {
      case "applyLeft":
        return command((s) => applyNonConflicting(s, "left"), true);
      case "applyAll":
        return command((s) => applyNonConflicting(s, "base"), true);
      case "applyRight":
        return command((s) => applyNonConflicting(s, "right"), true);
      case "resolveSimple":
        return command(resolveSimple, true);
      case "revert":
        return command(revertResolved, true);
      case "acceptYours":
        return acceptSide("left");
      case "acceptTheirs":
        return acceptSide("right");
      case "apply":
        return apply();
      case "cancel":
        return cancel();
      case "reload":
        return load();
      case "compare":
        return showCompareMenu(menuPosition("compare"));
      case "settings":
        return showSettingsMenu(menuPosition("settings"));
      case "autoApply":
        return setAutoApplyNonConflicting(!autoApply);
      case "syncScroll":
        return setSyncScroll((on) => !on);
      case "resolveWithAgent": {
        const v = resultView.current;
        if (!v) return;
        const indexes = selectionDecision(id)?.indexes.filter((i) => !isResolved(v.state.field(mergeField)[i]!));
        if (indexes?.length) await executeAction("agents.mergeConflicts", { key: input.key, indexes });
        return;
      }
      case "accept":
      case "resolveUsingYours":
      case "resolveUsingTheirs":
      case "ignore":
      case "resolveAutomatically": {
        const decision = selectionDecision(id);
        if (decision?.action) command((s) => applyTo(s, decision.indexes, decision.action!));
        return;
      }
      case "change": {
        const change = arg as { indexes: number[]; action: MergeAction } | undefined;
        if (change) command((s) => applyTo(s, change.indexes, change.action));
        return;
      }
      case "annotate": {
        const which = paneRef.current;
        const view = activePane();
        if (!state || !view || which === "result") return;
        const isHead = which === "left" ? !state.sides.reversed : state.sides.reversed;
        await toggleAnnotations(
          view,
          path,
          which === "left" ? state.ours : state.theirs,
          isHead ? "HEAD" : (state.sides.commit ?? "HEAD"),
        );
        return;
      }
      case "cut":
      case "copy":
      case "paste":
      case "selectAll": {
        const view = activePane();
        if (!view) return;
        const { from, to } = view.state.selection.main;
        if (id === "selectAll") view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        else if (id === "paste") {
          const text = await readClipboardPlainText().catch(() => undefined);
          if (text !== undefined) view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.paste" });
        } else {
          await copyText(view.state.sliceDoc(from, to));
          if (id === "cut") view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
        }
        return;
      }
      default: {
        const v = resultView.current;
        if (!state || !v || !(id in COMPARISONS)) return;
        const versions = {
          yours: { text: state.ours, label: txt(titles.yours) },
          base: { text: state.base ?? "", label: tx("Base") },
          result: { text: v.state.doc.toString(), label: tx("Result") },
          theirs: { text: state.theirs, label: txt(titles.theirs) },
        };
        const [a, b] = COMPARISONS[id as keyof typeof COMPARISONS];
        await openVcsDiff({ path, left: { type: "text", ...versions[a] }, right: { type: "text", ...versions[b] } });
      }
    }
  };

  useEffect(() => {
    Object.assign(actionHost, { enabled, run: runAction, autoApply: () => autoApply, syncScroll: () => syncScroll });
    refreshMergeActions(actionHost);
  });

  useEffect(() => {
    // Popup focus belongs to the editor that opened it; a real focus change releases it.
    const onFocus = (e: FocusEvent) => {
      const target = e.target as Element | null;
      if (!rootRef.current?.contains(target) && !target?.closest("[data-popup], [role=dialog]"))
        clearFocusedMergeEditor(actionHost);
    };
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
      clearFocusedMergeEditor(actionHost);
    };
  }, [actionHost]);

  const focusProps = {
    // WebKit doesn't focus a clicked button: focus then moves to the nearest focusable
    // ancestor, which must be this editor for the footer and toolbar buttons to keep it the
    // focused merge editor their actions run in.
    tabIndex: -1,
    onFocusCapture: (e: React.FocusEvent<HTMLDivElement>) => {
      const target = e.target as Node;
      if (oursRef.current?.contains(target)) paneRef.current = "left";
      else if (theirsRef.current?.contains(target)) paneRef.current = "right";
      else if (resultRef.current?.contains(target)) paneRef.current = "result";
      setFocusedMergeEditor(actionHost);
      setActiveMergeAgentTarget(input.key);
      setFocusedDiffNavigator(nav);
      setContext("diffEditorFocus", true);
    },
    onBlurCapture: (e: React.FocusEvent<HTMLDivElement>) => {
      const target = e.relatedTarget as Element | null;
      if (e.currentTarget.contains(target) || target?.closest("[data-popup], [role=dialog]")) return;
      clearFocusedMergeEditor(actionHost);
      if (focusedDiffNavigator() === nav) {
        setFocusedDiffNavigator(null);
        setContext("diffEditorFocus", false);
      }
    },
  };

  if (error)
    return (
      <div ref={rootRef} className={styles.message} {...focusProps}>
        {error}
        <Button onClick={() => void executeAction("merge.reload")}>
          <T>Retry</T>
        </Button>
      </div>
    );
  if (resolved)
    return (
      <div className={styles.message}>
        {tx`${baseName(path)} has been resolved and staged.`}
        <Button onClick={() => void editorService().openFile(path, { focus: true })}>
          <T>Open File</T>
        </Button>
      </div>
    );

  const agentName = agentProgress.providerName ?? tx("agent");
  const bannerMessage =
    agentProgress.state === "running"
      ? agentProgress.hunkCount === 1
        ? tx`Merging 1 conflict with ${agentName}…`
        : tx`Merging ${agentProgress.hunkCount ?? 0} conflicts with ${agentName}…`
      : agentProgress.state === "done"
        ? agentProgress.summary
          ? agentProgress.summary
          : agentProgress.hunkCount === 1
            ? tx`Agent resolved 1 change.`
            : tx`Agent resolved ${agentProgress.hunkCount ?? 0} changes.`
        : agentProgress.state === "error"
          ? (agentProgress.error ?? tx("Agent merge failed."))
          : "";

  return (
    <div ref={rootRef} className={clsx(styles.root, highlight === "none" && styles.noHighlight)} {...focusProps}>
      <MergeToolbar
        summary={summary}
        ignore={ignore}
        onIgnoreChange={setIgnore}
        highlight={highlight}
        onHighlightChange={setHighlight}
        syncScroll={syncScroll}
        onSyncScrollChange={setSyncScroll}
        agentRunning={agentProgress.state === "running"}
        onMergeByAgent={() => void executeAction("agents.mergeConflicts", { key: input.key })}
        onCancelAgent={() => void executeAction("agents.cancelMergeConflicts", { key: input.key })}
        step={goto}
        run={(c) => void runAction(c)}
      />
      {agentProgress.state !== "idle" && (
        <div
          className={clsx(
            styles.agentBanner,
            agentProgress.state === "running" && styles.agentBannerRunning,
            agentProgress.state === "done" && styles.agentBannerDone,
            agentProgress.state === "error" && styles.agentBannerError,
          )}
          role="status"
        >
          {agentProgress.state === "running" ? (
            <Spinner size={13} />
          ) : (
            <Icon name={agentProgress.state === "done" ? "check" : "error"} size={14} />
          )}
          <span className={styles.agentBannerText} title={bannerMessage}>
            {bannerMessage}
          </span>
          <div className={styles.agentBannerActions}>
            {agentProgress.state === "running" && (
              <Button
                size="small"
                onClick={() => void executeAction("agents.cancelMergeConflicts", { key: input.key })}
              >
                <T>Cancel</T>
              </Button>
            )}
            {agentProgress.state === "done" && (
              <Button
                size="small"
                icon="undo"
                onClick={() => {
                  const v = resultView.current;
                  if (v) {
                    undo(v);
                    v.focus();
                  }
                  setAgentProgress({ state: "idle" });
                }}
              >
                <T>Undo</T>
              </Button>
            )}
            {agentProgress.state === "error" && (
              <Button size="small" onClick={() => void executeAction("agents.mergeConflicts", { key: input.key })}>
                <T>Retry</T>
              </Button>
            )}
            {agentProgress.state !== "running" && (
              <IconButton
                icon="close"
                size="small"
                title="Dismiss"
                onClick={() => setAgentProgress({ state: "idle" })}
              />
            )}
          </div>
        </div>
      )}
      {!state || lang === null ? (
        <div className={styles.message}>
          <Spinner size={14} />
        </div>
      ) : null}
      <div className={styles.panes} hidden={!state || lang === null}>
        <SplitGroup className={styles.paneGroup} orientation="horizontal">
          <SplitPanel
            id={`${paneId}-yours`}
            role="region"
            aria-label={tx("Your version")}
            className={styles.sideColumn}
            minSize="18%"
            defaultSize="30%"
          >
            <div className={styles.paneTitle} title={yourTitle}>
              <Icon name="lock" size={12} className={styles.lockIcon} />
              <span className={styles.branchTitle}>{renderBranchLabel(yourTitle)}</span>
              <span className={styles.sideTitle}>{tx("Your version")}</span>
            </div>
            <div
              ref={oursRef}
              className={styles.pane}
              onContextMenu={(e) => oursView.current && showSideMenu(e, oursView.current, "left")}
            />
          </SplitPanel>
          <SplitHandle className={styles.divider} aria-label={tx("Resize left merge pane")}>
            <div ref={leftDividerRef} className={styles.band} aria-hidden />
          </SplitHandle>
          <SplitPanel id={`${paneId}-result`} role="region" aria-label={resultTitle} minSize="24%" defaultSize="40%">
            <div className={styles.resultTitle}>{resultTitle}</div>
            <div
              ref={resultRef}
              className={styles.pane}
              onContextMenu={(e) => resultView.current && showResultMenu(e, resultView.current)}
            />
          </SplitPanel>
          <SplitHandle className={styles.divider} aria-label={tx("Resize right merge pane")}>
            <div ref={rightDividerRef} className={styles.band} aria-hidden />
          </SplitHandle>
          <SplitPanel
            id={`${paneId}-theirs`}
            role="region"
            aria-label={tx("Their version")}
            className={styles.sideColumn}
            minSize="18%"
            defaultSize="30%"
          >
            <div className={styles.paneTitle} title={theirTitle}>
              <Icon name="lock" size={12} className={styles.lockIcon} />
              <span className={styles.branchTitle}>{renderBranchLabel(theirTitle)}</span>
              <span className={styles.sideTitle}>{tx("Their version")}</span>
            </div>
            <div
              ref={theirsRef}
              className={styles.pane}
              onContextMenu={(e) => theirsView.current && showSideMenu(e, theirsView.current, "right")}
            />
          </SplitPanel>
        </SplitGroup>
      </div>
      <MergeFooter run={(c) => void runAction(c)} />
    </div>
  );
}
