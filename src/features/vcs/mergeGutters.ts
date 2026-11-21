/**
 * The merge editor's per-change controls and 3-way IntelliJ-style highlighting:
 * mirrored Accept/Ignore buttons facing the Result pane, magic wand / Agent
 * controls in the Result gutter, and word-level + gutter + line highlighting
 * across all three panes.
 */
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  gutterLineClass,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { scrollbarMarks, type ScrollbarMark } from "@/editor/api";
import { overviewLane } from "@/editor/core/cm/lanes";
import { hasPrimaryModifier } from "@/platform/keymap";
import { tx } from "@/platform/i18n";
import { iconMarkup } from "@/ui";
import { compareWords, type ComparisonPolicy, type Range } from "./comparison";
import { DiffTooBigError } from "./comparison/lcs";
import type { HighlightPolicy, IgnorePolicy } from "./diffOptions";
import {
  canResolveAutomatically,
  changeType,
  changesSide,
  isConflict,
  isResolved,
  mergeField,
  sideChangeType,
  type MergeChange,
  type MergeChangeType,
  type MergeSide,
} from "./mergeModel";

/** What the controls do; `resolve` is set when the platform's modifier key is held. */
export interface MergeControls {
  accept(index: number, side: MergeSide, resolve: boolean): void;
  ignore(index: number, side: MergeSide, resolve: boolean): void;
  resolveAutomatically(index: number): void;
  resolveWithAgent?(index: number): void;
}

/** Tells a side pane how the changes stand, whenever the result moves them on. */
export const syncSide = StateEffect.define<readonly MergeChange[]>();

const sideChanges = StateField.define<readonly MergeChange[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(syncSide)) return e.value;
    return value;
  },
});

const KINDS: readonly MergeChangeType[] = ["conflict", "modified", "inserted", "deleted"];

const COMPARISON_POLICY: Record<IgnorePolicy, ComparisonPolicy> = {
  none: "default",
  trim: "trim",
  whitespace: "ignore",
  whitespaceAndLines: "ignore",
};

function button(className: string, title: string, icon: string, press: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = iconMarkup(icon, 14) ?? "";
  b.addEventListener("mousedown", (e) => {
    // Pointer presses keep the editor's focus and selection.
    e.preventDefault();
    e.stopPropagation();
  });
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    press(e);
  });
  return b;
}

class SideMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly side: MergeSide,
    readonly oneside: boolean,
    readonly controls: MergeControls,
  ) {
    super();
  }
  eq(other: SideMarker) {
    return other.index === this.index && other.side === this.side && other.oneside === this.oneside;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-merge-ops";
    const toward = this.side === "left" ? "right" : "left";
    const arrow = this.oneside ? `diff-arrow-${toward}-down` : `diff-arrow-${toward}`;
    const acceptBtn = button(
      "cm-merge-op cm-merge-accept",
      tx("Accept (hold the modifier key to resolve using this side)"),
      arrow,
      (e) => this.controls.accept(this.index, this.side, hasPrimaryModifier(e)),
    );
    const ignoreBtn = button(
      "cm-merge-op cm-merge-ignore",
      tx("Ignore (hold the modifier key to ignore both sides)"),
      "diff-remove",
      (e) => this.controls.ignore(this.index, this.side, hasPrimaryModifier(e)),
    );
    // Keep the accept chevron on the inner edge facing Result (IntelliJ layout).
    if (this.side === "left") box.append(ignoreBtn, acceptBtn);
    else box.append(acceptBtn, ignoreBtn);
    return box;
  }
}

/** Accept and Ignore beside each change of a side pane that is still to be decided, facing Result. */
export function sideControls(side: MergeSide, controls: MergeControls): Extension {
  return [
    sideChanges,
    gutter({
      class: "cm-merge-gutter",
      side: side === "left" ? "after" : "before",
      lineMarker(view, line) {
        const doc = view.state.doc;
        const changes = view.state.field(sideChanges);
        const index = changes.findIndex((c) => {
          if (!changesSide(c, side) || c.done[side]) return false;
          const from = (side === "left" ? c.leftRange : c.rightRange)[0];
          return doc.lineAt(Math.min(from, doc.length)).from === line.from;
        });
        return index < 0 ? null : new SideMarker(index, side, changes[index]!.oneside, controls);
      },
      lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(syncSide))),
    }),
  ];
}

class WandMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly controls: MergeControls,
  ) {
    super();
  }
  eq(other: WandMarker) {
    return other.index === this.index;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-merge-ops";
    box.append(
      button("cm-merge-op cm-merge-wand", tx("Resolve Automatically"), "diff-magic", () =>
        this.controls.resolveAutomatically(this.index),
      ),
    );
    return box;
  }
}

class AgentMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly controls: MergeControls,
  ) {
    super();
  }
  eq(other: AgentMarker) {
    return other.index === this.index;
  }
  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-merge-ops";
    box.append(
      button("cm-merge-op cm-merge-agent", tx("Resolve Conflict with Agent"), "toolwindow-agents", () =>
        this.controls.resolveWithAgent?.(this.index),
      ),
    );
    return box;
  }
}

/** Whether the changes of the result moved, were decided or were edited. */
export const mergeChanged = (u: ViewUpdate) =>
  u.docChanged || u.startState.field(mergeField) !== u.state.field(mergeField);

/**
 * The wand beside a conflict of the result that can be resolved without a decision,
 * or an Agent action button beside a real unresolved conflict.
 */
export function resultControls(controls: MergeControls): Extension {
  return gutter({
    class: "cm-merge-gutter cm-merge-result-gutter",
    lineMarker(view, line) {
      const doc = view.state.doc;
      const changes = view.state.field(mergeField);
      for (let i = 0; i < changes.length; i++) {
        const c = changes[i]!;
        if (!isConflict(c) || isResolved(c)) continue;
        if (doc.lineAt(Math.min(c.from, doc.length)).from !== line.from) continue;
        if (canResolveAutomatically(doc, c, "base")) return new WandMarker(i, controls);
        if (controls.resolveWithAgent) return new AgentMarker(i, controls);
        return null;
      }
      return null;
    },
    lineMarkerChange: mergeChanged,
  });
}

/** A change that adds/deletes lines so this pane has 0 lines here; a thin bar shows where it sits. */
class PointWidget extends WidgetType {
  constructor(readonly className: string) {
    super();
  }
  eq(other: PointWidget) {
    return other.className === this.className;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-merge-point ${this.className}`;
    return el;
  }
}

class EmptyWordMarker extends WidgetType {
  constructor(readonly kind: MergeChangeType) {
    super();
  }
  eq(other: EmptyWordMarker) {
    return other.kind === this.kind;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = `cm-mergeWordEmpty cm-mergeWord-${this.kind}`;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

class LineClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}

const gutterClassMarkers = new Map<string, LineClassMarker>();
function gutterClassMarker(elementClass: string): LineClassMarker {
  let m = gutterClassMarkers.get(elementClass);
  if (!m) {
    m = new LineClassMarker(elementClass);
    gutterClassMarkers.set(elementClass, m);
  }
  return m;
}

const wordMarkCache = new Map<MergeChangeType, Decoration>();
function wordMark(type: MergeChangeType): Decoration {
  let d = wordMarkCache.get(type);
  if (!d) {
    d = Decoration.mark({ class: `cm-mergeWord cm-mergeWord-${type}` });
    wordMarkCache.set(type, d);
  }
  return d;
}

const emptyWordDecoCache = new Map<MergeChangeType, Decoration>();
function emptyWordDeco(type: MergeChangeType): Decoration {
  let d = emptyWordDecoCache.get(type);
  if (!d) {
    d = Decoration.widget({ widget: new EmptyWordMarker(type), side: 1 });
    emptyWordDecoCache.set(type, d);
  }
  return d;
}

const sideWordDiffCache = new WeakMap<MergeChange, Map<string, readonly Range[] | null>>();
function getWordDiff(c: MergeChange, side: MergeSide, policy: ComparisonPolicy): readonly Range[] | null {
  const sideText = side === "left" ? c.left : c.right;
  if (!c.base || !sideText) return null;
  let perChange = sideWordDiffCache.get(c);
  if (!perChange) {
    perChange = new Map();
    sideWordDiffCache.set(c, perChange);
  }
  const key = `${side}:${policy}`;
  if (perChange.has(key)) return perChange.get(key)!;
  let res: readonly Range[] | null = null;
  try {
    res = compareWords(c.base, sideText, policy);
  } catch (e) {
    if (!(e instanceof DiffTooBigError)) throw e;
    res = null;
  }
  perChange.set(key, res);
  return res;
}

function addSegmentedWordMarks(
  decos: ReturnType<Decoration["range"]>[],
  baseOffset: number,
  text: string,
  start: number,
  end: number,
  type: MergeChangeType,
) {
  if (start === end) {
    decos.push(emptyWordDeco(type).range(baseOffset + start));
    return;
  }
  let pos = start;
  while (pos < end) {
    const nl = text.indexOf("\n", pos);
    const segEnd = nl < 0 || nl >= end ? end : nl;
    if (segEnd > pos) {
      decos.push(wordMark(type).range(baseOffset + pos, baseOffset + segEnd));
    }
    pos = nl < 0 || nl >= end ? end : nl + 1;
  }
}

function buildResultDecorations(state: EditorState, highlight: HighlightPolicy): DecorationSet {
  if (highlight === "none") return Decoration.none;
  const doc = state.doc;
  const decos: ReturnType<Decoration["range"]>[] = [];
  for (const c of state.field(mergeField)) {
    if (isResolved(c)) {
      if (c.to > c.from) {
        const first = doc.lineAt(c.from).number;
        const last = doc.lineAt(c.to - 1).number;
        const cls = c.agentResolved ? "cm-merge-resolved cm-merge-agentResolved" : "cm-merge-resolved";
        for (let n = first; n <= last; n++) {
          decos.push(Decoration.line({ class: cls }).range(doc.line(n).from));
        }
      }
      continue;
    }
    const type = changeType(c);
    if (c.to <= c.from) {
      decos.push(
        Decoration.widget({
          widget: new PointWidget(`cm-mergeLine-${type}`),
          block: true,
          side: -1,
        }).range(c.from),
      );
      continue;
    }
    const wordEligible =
      highlight === "words" &&
      c.base !== "" &&
      (c.left !== "" || c.right !== "") &&
      doc.sliceString(c.from, c.to) === c.base;
    let fine = false;
    if (wordEligible) {
      const intervals: Array<[number, number]> = [];
      const empties: number[] = [];
      const collect = (side: MergeSide) => {
        if (!changesSide(c, side)) return false;
        const diff = getWordDiff(c, side, "default");
        if (!diff) return false;
        for (const r of diff) {
          if (r.start1 < r.end1) intervals.push([r.start1, r.end1]);
          else if (r.start2 < r.end2) empties.push(r.start1);
        }
        return true;
      };
      const okL = !changesSide(c, "left") || collect("left");
      const okR = !changesSide(c, "right") || collect("right");
      if (okL && okR && (intervals.length > 0 || empties.length > 0)) {
        fine = true;
        intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const merged: Array<[number, number]> = [];
        for (const [s, e] of intervals) {
          const prev = merged[merged.length - 1];
          if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e);
          else merged.push([s, e]);
        }
        for (const [s, e] of merged) addSegmentedWordMarks(decos, c.from, c.base, s, e, type);
        for (const pos of new Set(empties)) {
          if (!merged.some(([s, e]) => pos >= s && pos <= e)) {
            decos.push(emptyWordDeco(type).range(c.from + pos));
          }
        }
      }
    }
    const first = doc.lineAt(c.from).number;
    const last = doc.lineAt(c.to - 1).number;
    for (let n = first; n <= last; n++) {
      const cls = [
        "cm-mergeLine",
        `cm-mergeLine-${type}`,
        fine ? "cm-mergeLine-fine" : "",
        n === first ? "cm-mergeLine-start" : "",
        n === last ? "cm-mergeLine-end" : "",
      ]
        .filter(Boolean)
        .join(" ");
      decos.push(Decoration.line({ class: cls }).range(doc.line(n).from));
    }
  }
  return Decoration.set(decos, true);
}

function buildResultGutterMarkers(
  state: EditorView["state"],
  highlight: HighlightPolicy,
): RangeSetBuilder<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const doc = state.doc;
  const entries: Array<{ from: number; marker: LineClassMarker }> = [];
  for (const c of state.field(mergeField)) {
    if (c.to <= c.from) continue;
    const first = doc.lineAt(c.from).number;
    const last = doc.lineAt(c.to - 1).number;
    if (isResolved(c)) {
      if (c.agentResolved) {
        const marker = gutterClassMarker("cm-mergeGutter-resolved cm-mergeGutter-agentResolved");
        for (let n = first; n <= last; n++) entries.push({ from: doc.line(n).from, marker });
      }
      continue;
    }
    if (highlight === "none") continue;
    const type = changeType(c);
    const fine =
      highlight === "words" &&
      c.base !== "" &&
      (!changesSide(c, "left") || !!getWordDiff(c, "left", "default")) &&
      (!changesSide(c, "right") || !!getWordDiff(c, "right", "default")) &&
      doc.sliceString(c.from, c.to) === c.base;
    const marker = gutterClassMarker(`cm-mergeGutter cm-mergeGutter-${type}${fine ? " cm-mergeGutter-fine" : ""}`);
    for (let n = first; n <= last; n++) entries.push({ from: doc.line(n).from, marker });
  }
  entries.sort((a, b) => a.from - b.from);
  let lastFrom = -1;
  for (const { from, marker } of entries) {
    if (from === lastFrom) continue;
    lastFrom = from;
    builder.add(from, from, marker);
  }
  return builder;
}

/** The changes tinted in the result (code lines, words, and gutters). */
export function createResultMarks(highlight: HighlightPolicy = "words"): Extension {
  // Block PointWidgets require a StateField (CodeMirror forbids block decorations from ViewPlugins).
  const lineAndWord = StateField.define<DecorationSet>({
    create: (state) => buildResultDecorations(state, highlight),
    update(value, tr) {
      if (tr.docChanged || tr.startState.field(mergeField) !== tr.state.field(mergeField)) {
        return buildResultDecorations(tr.state, highlight);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  const gutterField = StateField.define({
    create: (state) => buildResultGutterMarkers(state, highlight).finish(),
    update(value, tr) {
      if (tr.docChanged || tr.startState.field(mergeField) !== tr.state.field(mergeField)) {
        return buildResultGutterMarkers(tr.state, highlight).finish();
      }
      return value;
    },
    provide: (f) => gutterLineClass.from(f),
  });
  return [lineAndWord, gutterField];
}

function buildSideDecorations(
  state: EditorState,
  side: MergeSide,
  highlight: HighlightPolicy,
  ignore: IgnorePolicy,
): DecorationSet {
  if (highlight === "none") return Decoration.none;
  const doc = state.doc;
  const changes = state.field(sideChanges);
  const policy = COMPARISON_POLICY[ignore];
  const decos: ReturnType<Decoration["range"]>[] = [];
  for (const c of changes) {
    if (!changesSide(c, side) || c.done[side]) continue;
    const type = sideChangeType(c, side);
    const [rawFrom, rawTo] = side === "left" ? c.leftRange : c.rightRange;
    const from = Math.min(rawFrom, doc.length);
    const to = Math.min(rawTo, doc.length);
    if (to <= from) {
      decos.push(
        Decoration.widget({
          widget: new PointWidget(`cm-mergeLine-${type}`),
          block: true,
          side: -1,
        }).range(from),
      );
      continue;
    }
    const sideText = side === "left" ? c.left : c.right;
    const diff = highlight === "words" ? getWordDiff(c, side, policy) : null;
    const fine = !!diff;
    if (diff) {
      for (const r of diff) addSegmentedWordMarks(decos, from, sideText, r.start2, r.end2, type);
    }
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to - 1).number;
    for (let n = first; n <= last; n++) {
      const cls = [
        "cm-mergeLine",
        `cm-mergeLine-${type}`,
        fine ? "cm-mergeLine-fine" : "",
        n === first ? "cm-mergeLine-start" : "",
        n === last ? "cm-mergeLine-end" : "",
      ]
        .filter(Boolean)
        .join(" ");
      decos.push(Decoration.line({ class: cls }).range(doc.line(n).from));
    }
  }
  return Decoration.set(decos, true);
}

function buildSideGutterMarkers(
  state: EditorView["state"],
  side: MergeSide,
  highlight: HighlightPolicy,
  ignore: IgnorePolicy,
) {
  const builder = new RangeSetBuilder<GutterMarker>();
  if (highlight === "none") return builder.finish();
  const doc = state.doc;
  const changes = state.field(sideChanges);
  const policy = COMPARISON_POLICY[ignore];
  const entries: Array<{ from: number; marker: LineClassMarker }> = [];
  for (const c of changes) {
    if (!changesSide(c, side) || c.done[side]) continue;
    const [rawFrom, rawTo] = side === "left" ? c.leftRange : c.rightRange;
    const from = Math.min(rawFrom, doc.length);
    const to = Math.min(rawTo, doc.length);
    if (to <= from) continue;
    const type = sideChangeType(c, side);
    const fine = highlight === "words" && !!getWordDiff(c, side, policy);
    const marker = gutterClassMarker(`cm-mergeGutter cm-mergeGutter-${type}${fine ? " cm-mergeGutter-fine" : ""}`);
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to - 1).number;
    for (let n = first; n <= last; n++) entries.push({ from: doc.line(n).from, marker });
  }
  entries.sort((a, b) => a.from - b.from);
  let lastFrom = -1;
  for (const { from, marker } of entries) {
    if (from === lastFrom) continue;
    lastFrom = from;
    builder.add(from, from, marker);
  }
  return builder.finish();
}

/** True 3-way IntelliJ line, word and gutter highlighting for a side pane against the base. */
export function sideMarks(side: MergeSide, highlight: HighlightPolicy, ignore: IgnorePolicy): Extension {
  const lineAndWord = StateField.define<DecorationSet>({
    create: (state) => buildSideDecorations(state, side, highlight, ignore),
    update(value, tr) {
      if (tr.docChanged || tr.startState.field(sideChanges) !== tr.state.field(sideChanges)) {
        return buildSideDecorations(tr.state, side, highlight, ignore);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  const gutterField = StateField.define({
    create: (state) => buildSideGutterMarkers(state, side, highlight, ignore),
    update(value, tr) {
      if (tr.docChanged || tr.startState.field(sideChanges) !== tr.state.field(sideChanges)) {
        return buildSideGutterMarkers(tr.state, side, highlight, ignore);
      }
      return value;
    },
    provide: (f) => gutterLineClass.from(f),
  });
  return [lineAndWord, gutterField];
}

const stripeMark = (c: MergeChange, from: number, to: number): ScrollbarMark => {
  const type = changeType(c);
  return {
    from,
    to: to > from ? to - 1 : from,
    color: `var(--diff-${type}-stripe)`,
    kind: "full",
    priority: type === "conflict" ? 1 : 0,
  };
};

/**
 * The open changes on a pane's overview lane, as IDEA's merge viewer: the result marks each
 * change until it is resolved, a side pane the changes of that side until that side is accepted
 * or ignored (TextMergeChange: a resolved side paints no background, so no stripe either).
 */
export function mergeStripe(pane: MergeSide | "result"): Extension {
  const marks =
    pane === "result"
      ? scrollbarMarks.compute([mergeField], (state): readonly ScrollbarMark[] =>
          state.field(mergeField).flatMap((c) => (isResolved(c) ? [] : [stripeMark(c, c.from, c.to)])),
        )
      : scrollbarMarks.compute([sideChanges], (state): readonly ScrollbarMark[] =>
          state.field(sideChanges).flatMap((c) => {
            if (!changesSide(c, pane) || c.done[pane]) return [];
            const [from, to] = pane === "left" ? c.leftRange : c.rightRange;
            return [stripeMark(c, from, to)];
          }),
        );
  return [marks, overviewLane];
}

export const mergeTheme = EditorView.baseTheme({
  // A fixed width, so the text does not shift as controls come and go while scrolling.
  ".cm-merge-gutter": { minWidth: "36px" },
  ".cm-merge-result-gutter": { minWidth: "24px" },
  ".cm-merge-ops": { display: "flex", alignItems: "center", justifyContent: "center", gap: "2px", height: "100%" },
  ".cm-merge-op": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    padding: 0,
    border: "none",
    borderRadius: "var(--radius-small)",
    color: "var(--fg-secondary)",
    background: "transparent",
  },
  ".cm-merge-op:hover": { color: "var(--fg-strong)", background: "var(--bg-control-hover)" },
  ".cm-merge-agent:hover": { color: "var(--accent)", background: "var(--accent-soft)" },
  ...Object.assign(
    {},
    ...KINDS.flatMap((k) => [
      {
        [`.cm-line.cm-mergeLine-${k}`]: {
          backgroundColor: `color-mix(in srgb, var(--diff-${k}) 72%, transparent)`,
        },
      },
      {
        [`.cm-line.cm-mergeLine-fine.cm-mergeLine-${k}`]: {
          backgroundColor: `color-mix(in srgb, var(--diff-${k}) 30%, transparent)`,
        },
      },
      {
        [`.cm-line.cm-mergeLine-start.cm-mergeLine-${k}`]: {
          boxShadow: `inset 0 1px 0 color-mix(in srgb, var(--diff-${k}-stripe) 55%, transparent)`,
        },
      },
      {
        [`.cm-line.cm-mergeLine-end.cm-mergeLine-${k}`]: {
          boxShadow: `inset 0 -1px 0 color-mix(in srgb, var(--diff-${k}-stripe) 55%, transparent)`,
        },
      },
      {
        [`.cm-line.cm-mergeLine-start.cm-mergeLine-end.cm-mergeLine-${k}`]: {
          boxShadow:
            `inset 0 1px 0 color-mix(in srgb, var(--diff-${k}-stripe) 55%, transparent), ` +
            `inset 0 -1px 0 color-mix(in srgb, var(--diff-${k}-stripe) 55%, transparent)`,
        },
      },
      {
        [`.cm-gutterElement.cm-mergeGutter-${k}`]: {
          backgroundColor: `color-mix(in srgb, var(--diff-${k}) 82%, var(--bg-app))`,
        },
      },
      {
        [`.cm-mergeWord-${k}`]: {
          display: "inline-block",
          backgroundColor: `var(--diff-${k})`,
          borderRadius: "2px",
        },
      },
      {
        [`.cm-merge-point.cm-mergeLine-${k}`]: {
          backgroundColor: `var(--diff-${k}-stripe)`,
        },
      },
    ]),
  ),
  ".cm-mergeWordEmpty": {
    display: "inline-block",
    width: "2px",
    height: "1lh",
    margin: "0 -1px",
    verticalAlign: "top",
  },
  ".cm-line.cm-merge-agentResolved": {
    boxShadow: "inset 2px 0 0 color-mix(in srgb, var(--accent) 55%, transparent)",
  },
  ".cm-gutterElement.cm-mergeGutter-agentResolved": {
    boxShadow: "inset 2px 0 0 color-mix(in srgb, var(--accent) 45%, transparent)",
  },
  ".cm-merge-point": { height: "2px", margin: "0", pointerEvents: "none" },
});
