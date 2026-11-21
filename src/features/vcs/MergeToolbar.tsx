/** The merge editor's toolbar and the buttons along its bottom, after IntelliJ's merge dialog. */
import clsx from "clsx";
import { tx } from "@/platform/i18n";
import { Button, Icon, IconButton, Select, Spinner, T } from "@/ui";
import { HIGHLIGHT_OPTIONS, IGNORE_OPTIONS, type HighlightPolicy, type IgnorePolicy } from "./diffOptions";
import type { MergeCommand } from "./mergeActions";
import type { MergeSummary } from "./mergeModel";
import styles from "./MergeEditor.module.css";

export interface ToolbarProps {
  summary: MergeSummary;
  ignore: IgnorePolicy;
  onIgnoreChange: (policy: IgnorePolicy) => void;
  highlight: HighlightPolicy;
  onHighlightChange: (policy: HighlightPolicy) => void;
  syncScroll: boolean;
  onSyncScrollChange: (on: boolean) => void;
  agentRunning: boolean;
  onMergeByAgent: () => void;
  onCancelAgent: () => void;
  /** Moves between the unresolved changes of this merge editor. */
  step: (dir: 1 | -1) => void;
  /** Runs a command on this merge editor, whether or not it has focus. */
  run: (command: MergeCommand) => void;
}

/** Runs the button's command on its own editor; the action only supplies title and shortcut. */
const direct = (run: () => void) => (e: React.MouseEvent) => {
  e.preventDefault();
  run();
};

function statusText({ pending, conflicts }: MergeSummary) {
  if (!pending) return tx("All changes processed");
  const left = pending === 1 ? tx`${pending} change left` : tx`${pending} changes left`;
  if (!conflicts) return left;
  return `${left}, ${conflicts === 1 ? tx`${conflicts} conflict` : tx`${conflicts} conflicts`}`;
}

export function MergeToolbar({
  summary,
  ignore,
  onIgnoreChange,
  highlight,
  onHighlightChange,
  syncScroll,
  onSyncScrollChange,
  agentRunning,
  onMergeByAgent,
  onCancelAgent,
  step,
  run,
}: ToolbarProps) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Merge")}>
      <IconButton
        icon="arrow-up"
        title="Previous Change"
        action="diff.prevDifference"
        size="small"
        disabled={!summary.pending}
        onClick={direct(() => step(-1))}
      />
      <IconButton
        icon="arrow-down"
        title="Next Change"
        action="diff.nextDifference"
        size="small"
        disabled={!summary.pending}
        onClick={direct(() => step(1))}
      />
      <IconButton
        icon="diff"
        title="Compare Contents"
        size="small"
        action="merge.compare"
        onClick={direct(() => run("compare"))}
        data-merge-menu="compare"
      />
      <span className={styles.sep} />
      <span className={styles.toolbarLabel}>
        <T>Apply non-conflicting changes:</T>
      </span>
      <button
        type="button"
        className={styles.applyBtn}
        title={tx("Apply Non-Conflicting Changes from the Left Side")}
        aria-label={tx("Apply Non-Conflicting Changes from the Left Side")}
        disabled={!summary.left}
        onMouseDown={(e) => e.preventDefault()}
        onClick={direct(() => run("applyLeft"))}
      >
        <Icon name="diff-apply-left" size={14} />
        <span className={styles.applyBtnText}>
          <T>Left</T>
        </span>
      </button>
      <button
        type="button"
        className={styles.applyBtn}
        title={tx("Apply All Non-Conflicting Changes")}
        aria-label={tx("Apply All Non-Conflicting Changes")}
        disabled={!summary.all}
        onMouseDown={(e) => e.preventDefault()}
        onClick={direct(() => run("applyAll"))}
      >
        <Icon name="diff-apply-all" size={14} />
        <span className={styles.applyBtnText}>
          <T>All</T>
        </span>
      </button>
      <button
        type="button"
        className={styles.applyBtn}
        title={tx("Apply Non-Conflicting Changes from the Right Side")}
        aria-label={tx("Apply Non-Conflicting Changes from the Right Side")}
        disabled={!summary.right}
        onMouseDown={(e) => e.preventDefault()}
        onClick={direct(() => run("applyRight"))}
      >
        <Icon name="diff-apply-right" size={14} />
        <span className={styles.applyBtnText}>
          <T>Right</T>
        </span>
      </button>
      <IconButton
        icon="diff-magic-toolbar"
        title="Resolve Simple Conflicts"
        size="small"
        disabled={!summary.simple}
        action="merge.resolveSimple"
        onClick={direct(() => run("resolveSimple"))}
      />
      <IconButton
        icon="diff-revert"
        iconSize={14}
        title="Revert Conflict Resolution"
        size="small"
        disabled={!summary.revert}
        action="merge.revert"
        onClick={direct(() => run("revert"))}
      />
      <span className={styles.sep} />
      <button
        type="button"
        className={clsx(styles.agentBtn, agentRunning && styles.agentBtnRunning)}
        title={agentRunning ? tx("Cancel Agent Merge") : tx("Merge Conflicts with Agent")}
        aria-label={agentRunning ? tx("Cancel Agent Merge") : undefined}
        disabled={!agentRunning && !summary.pending}
        onMouseDown={(e) => e.preventDefault()}
        onClick={direct(agentRunning ? onCancelAgent : onMergeByAgent)}
      >
        {agentRunning ? <Spinner size={14} /> : <Icon name="toolwindow-agents" size={14} />}
        <span>{agentRunning ? <T>Cancel</T> : <T>Merge by Agent</T>}</span>
      </button>
      <span className={styles.sep} />
      <Select<IgnorePolicy>
        className={styles.select}
        value={ignore}
        options={IGNORE_OPTIONS}
        onChange={onIgnoreChange}
        aria-label="Ignore whitespace"
      />
      <Select<HighlightPolicy>
        className={styles.select}
        value={highlight}
        options={HIGHLIGHT_OPTIONS}
        onChange={onHighlightChange}
        aria-label="Highlighting"
      />
      <IconButton
        icon="lock"
        title="Synchronize Scrolling"
        size="small"
        pressed={syncScroll}
        onClick={direct(() => onSyncScrollChange(!syncScroll))}
      />
      <span
        className={clsx(
          styles.status,
          !summary.pending ? styles.statusDone : !summary.conflicts && styles.statusPending,
        )}
        role="status"
      >
        {statusText(summary)}
      </span>
      <IconButton
        icon="refresh"
        title="Reload from Disk"
        size="small"
        action="merge.reload"
        onClick={direct(() => run("reload"))}
      />
      <IconButton
        icon="settings"
        title="Settings"
        size="small"
        action="merge.settings"
        onClick={direct(() => run("settings"))}
        data-merge-menu="settings"
      />
    </div>
  );
}

export function MergeFooter({ run }: Pick<ToolbarProps, "run">) {
  return (
    <div className={styles.footer}>
      <div className={styles.footerGroup}>
        <Button onClick={() => run("acceptYours")}>
          <T>Accept Yours</T>
        </Button>
        <Button onClick={() => run("acceptTheirs")}>
          <T>Accept Theirs</T>
        </Button>
      </div>
      <div className={styles.footerGroup}>
        <Button onClick={() => run("cancel")}>
          <T>Cancel</T>
        </Button>
        <Button variant="primary" onClick={() => run("apply")}>
          <T>Apply</T>
        </Button>
      </div>
    </div>
  );
}
