// Pure helpers for the remembered-mode preference (#25). Kept out of sidebar.ts
// so the policy — "remember the last Agent/Auto-accept switch, never Plan; apply
// it to new sessions only" — is unit-testable without vscode/spawn.

export type ModeId = "agent" | "plan" | "yolo";

/**
 * The mode value to persist for a user's mode switch, or `null` to leave the
 * remembered preference unchanged. Plan is a transient per-task choice, so it is
 * never remembered (#25). Mirrors how `defaultModel`/`defaultEffort` persist.
 */
export function modeToRemember(modeId: ModeId): "agent" | "yolo" | null {
  return modeId === "plan" ? null : modeId;
}

/**
 * Whether a brand-new session should start in Auto accept (YOLO), given the
 * remembered `grok.defaultMode` and whether this start is a resume. Resumed
 * sessions are verdict-driven (plan-restore decides), so they never pre-apply
 * the remembered mode.
 */
export function startsInYolo(defaultMode: string | undefined, isResume: boolean): boolean {
  return !isResume && defaultMode === "yolo";
}

/**
 * Snapshot Auto accept for restore when Plan is raised. Re-entrant plan entry
 * (user setMode("plan") then CLI `current_mode_update: plan`, or a second
 * announcement while already planning) must keep the first stash — by then
 * `autoApprove` is already false, so re-capturing would permanently lose YOLO.
 */
export function captureAutoApproveBeforePlan(
  alreadyPlanActive: boolean,
  autoApprove: boolean,
  existingStash: boolean,
): boolean {
  return alreadyPlanActive ? existingStash : autoApprove;
}

/**
 * After Approve / Abandon leave Plan, restore the pre-plan Auto accept flag.
 * Reject keeps Plan up and leaves the stash untouched for a later leave.
 */
export function restoreAutoApproveAfterPlan(stashed: boolean): {
  autoApprove: boolean;
  autoApproveBeforePlan: boolean;
} {
  return { autoApprove: stashed, autoApproveBeforePlan: false };
}
