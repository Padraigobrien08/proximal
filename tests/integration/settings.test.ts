import { afterEach, describe, expect, it } from "vitest";
import { insertCourse } from "../../src/lib/db/repo";
import { clampSessionMinutes, getStudyPlanSettings, setStudyPlanSettings } from "../../src/lib/services/settings";
import { getHomeView, planFor } from "../../src/lib/services/views";
import { createTestContext, T0 } from "../helpers";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function setup() {
  const t = await createTestContext();
  cleanup = t.cleanup;
  return t;
}

describe("study plan settings", () => {
  it("plans across all modules by default and can be limited to chosen modules", async () => {
    const { ctx } = await setup();
    expect(getStudyPlanSettings(ctx)).toEqual({ modules: "all", moduleIds: [] });
    expect(planFor(ctx, 25).plan.length).toBeGreaterThan(0);

    insertCourse(ctx.db, { id: "other", title: "Other module", isDemo: false, status: "approved", createdAt: T0 });
    setStudyPlanSettings(ctx, { modules: "chosen", moduleIds: ["other", "unknown-id"] });
    expect(getStudyPlanSettings(ctx)).toEqual({ modules: "chosen", moduleIds: ["other"] });
    // The demo module is left out of the overall plan, but its own Study now still works.
    expect(planFor(ctx, 25).plan).toEqual([]);
    expect(planFor(ctx, 25, { courseId: "demo-course" }).plan.length).toBeGreaterThan(0);
    const home = getHomeView(ctx, 25);
    expect(home.modules.find((m) => m.id === "demo-course")).toMatchObject({ inPlan: false, nextUp: { kindLabel: "Learn" } });
  });

  it("rejects an empty chosen set", async () => {
    const { ctx } = await setup();
    expect(() => setStudyPlanSettings(ctx, { modules: "chosen", moduleIds: [] })).toThrow(/at least one module/);
  });

  it("keeps session lengths on the dial's five-minute steps", () => {
    expect(clampSessionMinutes(23)).toBe(25);
    expect(clampSessionMinutes(1)).toBe(5);
    expect(clampSessionMinutes(500)).toBe(60);
    expect(clampSessionMinutes(Number.NaN)).toBe(25);
  });

  it("longer sessions hold more steps", async () => {
    const { ctx } = await setup();
    expect(planFor(ctx, 10).plan.length).toBeLessThan(planFor(ctx, 60).plan.length);
  });
});
