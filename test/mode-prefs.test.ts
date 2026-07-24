import { describe, it, expect } from "vitest";
import {
  captureAutoApproveBeforePlan,
  modeToRemember,
  restoreAutoApproveAfterPlan,
  startsInYolo,
} from "../src/mode-prefs";

/** Mirrors Session flags + sidebar displayMode / enter-plan / leave-plan policy. */
type ModeFlags = {
  planActive: boolean;
  autoApprove: boolean;
  autoApproveBeforePlan: boolean;
};

function displayMode(s: ModeFlags): "agent" | "plan" | "yolo" {
  if (s.planActive) return "plan";
  if (s.autoApprove) return "yolo";
  return "agent";
}

/** Same as setMode("plan") / modeChanged("plan") in sidebar.ts. */
function enterPlan(s: ModeFlags): void {
  s.autoApproveBeforePlan = captureAutoApproveBeforePlan(
    s.planActive,
    s.autoApprove,
    s.autoApproveBeforePlan,
  );
  s.autoApprove = false;
  s.planActive = true;
}

/** Same as Approve / Abandon in handleExitPlan (not Reject). */
function leavePlanToAct(s: ModeFlags): void {
  const next = restoreAutoApproveAfterPlan(s.autoApproveBeforePlan);
  s.autoApprove = next.autoApprove;
  s.autoApproveBeforePlan = next.autoApproveBeforePlan;
  s.planActive = false;
}

function flags(init: Partial<ModeFlags> = {}): ModeFlags {
  return {
    planActive: false,
    autoApprove: false,
    autoApproveBeforePlan: false,
    ...init,
  };
}

describe("remembered mode preference (#25)", () => {
  it("remembers a switch to Agent or Auto accept, but never Plan", () => {
    expect(modeToRemember("agent")).toBe("agent");
    expect(modeToRemember("yolo")).toBe("yolo");
    // Plan is a transient per-task choice — leave the remembered preference alone.
    expect(modeToRemember("plan")).toBeNull();
  });

  it("starts a NEW session in Auto accept only when that's the remembered mode", () => {
    expect(startsInYolo("yolo", false)).toBe(true);
    expect(startsInYolo("agent", false)).toBe(false);
    expect(startsInYolo("", false)).toBe(false); // unset = Agent
    expect(startsInYolo(undefined, false)).toBe(false);
  });

  it("never pre-applies the remembered mode on a resume (those are verdict-driven)", () => {
    expect(startsInYolo("yolo", true)).toBe(false);
    expect(startsInYolo("agent", true)).toBe(false);
  });
});

describe("mode survives Plan enter → leave", () => {
  it("stashes Auto accept on first plan enter", () => {
    expect(captureAutoApproveBeforePlan(false, true, false)).toBe(true);
    expect(captureAutoApproveBeforePlan(false, false, false)).toBe(false);
  });

  it("keeps the first stash on re-entrant plan entry (autoApprove already cleared)", () => {
    // User/CLI already raised Plan: autoApprove is false, stash was true.
    // A second capture must not overwrite true → false.
    expect(captureAutoApproveBeforePlan(true, false, true)).toBe(true);
    expect(captureAutoApproveBeforePlan(true, false, false)).toBe(false);
  });

  it("restores Auto accept on Approve/Abandon leave", () => {
    expect(restoreAutoApproveAfterPlan(true)).toEqual({
      autoApprove: true,
      autoApproveBeforePlan: false,
    });
    expect(restoreAutoApproveAfterPlan(false)).toEqual({
      autoApprove: false,
      autoApproveBeforePlan: false,
    });
  });

  it("Agent → Plan → Approve returns to Agent", () => {
    const s = flags({ autoApprove: false });
    expect(displayMode(s)).toBe("agent");

    enterPlan(s);
    expect(displayMode(s)).toBe("plan");
    expect(s.autoApprove).toBe(false);
    expect(s.autoApproveBeforePlan).toBe(false);

    // CLI may echo current_mode_update: plan again while already planning
    enterPlan(s);
    expect(s.autoApproveBeforePlan).toBe(false);

    leavePlanToAct(s);
    expect(displayMode(s)).toBe("agent");
    expect(s.autoApprove).toBe(false);
    expect(s.planActive).toBe(false);
    expect(s.autoApproveBeforePlan).toBe(false);
  });

  it("Agent → Plan → Abandon returns to Agent", () => {
    const s = flags({ autoApprove: false });
    enterPlan(s);
    leavePlanToAct(s);
    expect(displayMode(s)).toBe("agent");
    expect(s.autoApprove).toBe(false);
  });

  it("Auto accept → Plan → Approve returns to Auto accept", () => {
    const s = flags({ autoApprove: true });
    expect(displayMode(s)).toBe("yolo");

    enterPlan(s);
    expect(displayMode(s)).toBe("plan");
    expect(s.autoApprove).toBe(false);
    expect(s.autoApproveBeforePlan).toBe(true);

    // CLI echoes plan again — stash must not be wiped to false
    enterPlan(s);
    expect(s.autoApproveBeforePlan).toBe(true);

    leavePlanToAct(s);
    expect(displayMode(s)).toBe("yolo");
    expect(s.autoApprove).toBe(true);
    expect(s.planActive).toBe(false);
    expect(s.autoApproveBeforePlan).toBe(false);
  });

  it("Auto accept → Plan → Abandon returns to Auto accept", () => {
    const s = flags({ autoApprove: true });
    enterPlan(s);
    leavePlanToAct(s);
    expect(displayMode(s)).toBe("yolo");
    expect(s.autoApprove).toBe(true);
  });

  it("Reject keeps Plan and preserves stash for a later Approve", () => {
    const s = flags({ autoApprove: true });
    enterPlan(s);
    // Reject: stay in plan, do not restore
    expect(displayMode(s)).toBe("plan");
    expect(s.autoApproveBeforePlan).toBe(true);

    leavePlanToAct(s); // later Approve
    expect(displayMode(s)).toBe("yolo");
  });
});
