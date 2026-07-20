import { describe, expect, it } from "vitest";
import {
  formatTimeRange,
  renderBodyMeasurement,
  renderExerciseHistory,
  renderExerciseTemplate,
  renderRoutine,
  renderSet,
  renderWorkout,
  stripNulls,
  type RenderOptions,
} from "../render";

const NY_IMPERIAL: RenderOptions = { timeZone: "America/New_York", units: "imperial" };

describe("stripNulls", () => {
  it("drops null fields recursively but keeps zero and empty string", () => {
    expect(
      stripNulls({ a: null, b: 0, c: "", d: { e: null, f: 1 }, g: [{ h: null, i: 2 }] }),
    ).toEqual({ b: 0, c: "", d: { f: 1 }, g: [{ i: 2 }] });
  });
});

describe("formatTimeRange", () => {
  it("humanizes a start/end pair with duration", () => {
    expect(formatTimeRange("2026-07-19T12:00:00Z", "2026-07-19T13:10:00Z")).toBe(
      "Jul 19 2026, 12:00–13:10 UTC (1h10m)",
    );
  });

  it("handles sub-hour durations and missing end", () => {
    expect(formatTimeRange("2026-07-19T12:00:00Z", "2026-07-19T12:45:00Z")).toBe(
      "Jul 19 2026, 12:00–12:45 UTC (45m)",
    );
    expect(formatTimeRange("2026-07-19T12:00:00Z", undefined)).toBe("Jul 19 2026, 12:00 UTC");
  });

  it("falls back to the raw string on unparseable input", () => {
    expect(formatTimeRange("not-a-date", undefined)).toBe("not-a-date");
  });
});

describe("renderSet", () => {
  it("renders weight and reps compactly", () => {
    expect(renderSet({ weight_kg: 100, reps: 5 })).toBe("100kg×5");
  });

  it("prefixes non-normal set types and appends RPE", () => {
    expect(renderSet({ type: "warmup", weight_kg: 60, reps: 10 })).toBe("warmup 60kg×10");
    expect(renderSet({ weight_kg: 100, reps: 5, rpe: 8.5 })).toBe("100kg×5 @8.5");
  });

  it("renders cardio and bodyweight sets", () => {
    expect(renderSet({ distance_meters: 2000, duration_seconds: 480 })).toBe("2000m 480s");
    expect(renderSet({ reps: 12 })).toBe("×12");
  });

  it("renders routine rep ranges", () => {
    expect(renderSet({ weight_kg: 100, rep_range: { start: 8, end: 12 } })).toBe("100kg×8–12");
  });
});

describe("renderWorkout", () => {
  it("includes ids, humanized times, description, and multiline notes", () => {
    const text = renderWorkout({
      id: "b459cba5-cd6d-463c-abd6-54f8eafcadcb",
      title: "Push Day",
      description: "Felt strong.\nSlept 9 hours.",
      start_time: "2026-07-19T12:00:00Z",
      end_time: "2026-07-19T13:10:00Z",
      exercises: [
        {
          title: "Bench Press (Barbell)",
          exercise_template_id: "05293BCA",
          notes: "Paused reps.\nSlow negatives.",
          sets: [
            { type: "warmup", weight_kg: 60, reps: 10 },
            { type: "normal", weight_kg: 100, reps: 5, rpe: 8 },
          ],
        },
      ],
    });
    expect(text).toBe(
      [
        "## Push Day — Jul 19 2026, 12:00–13:10 UTC (1h10m) (id b459cba5-cd6d-463c-abd6-54f8eafcadcb)",
        "Felt strong.",
        "Slept 9 hours.",
        "- Bench Press (Barbell) [05293BCA]: warmup 60kg×10, 100kg×5 @8",
        "  note: Paused reps.",
        "    Slow negatives.",
      ].join("\n"),
    );
  });
});

describe("renderRoutine", () => {
  it("includes rest times and rep ranges", () => {
    const text = renderRoutine({
      id: "0a72f4c1-9a20-45d3-8b6a-2f9f8d7f4b11",
      title: "Upper Body",
      folder_id: 42,
      exercises: [
        {
          title: "Bench Press (Barbell)",
          exercise_template_id: "05293BCA",
          rest_seconds: 90,
          sets: [
            {
              type: "normal",
              weight_kg: 100,
              sets: undefined,
              rep_range: { start: 8, end: 12 },
            } as never,
          ],
        },
      ],
    });
    expect(text).toContain("folder: 42");
    expect(text).toContain("100kg×8–12");
    expect(text).toContain("rest 90s");
  });
});

describe("renderExerciseHistory", () => {
  it("groups per-set entries into one line per workout", () => {
    const text = renderExerciseHistory({
      exercise_history: [
        {
          workout_id: "w1",
          workout_title: "Push Day",
          workout_start_time: "2026-07-19T12:00:00Z",
          weight_kg: 100,
          reps: 5,
          set_type: "normal",
        },
        {
          workout_id: "w1",
          workout_title: "Push Day",
          workout_start_time: "2026-07-19T12:00:00Z",
          weight_kg: 100,
          reps: 4,
          set_type: "failure",
        },
        {
          workout_id: "w2",
          workout_title: "Push Day",
          workout_start_time: "2026-07-12T12:00:00Z",
          weight_kg: 95,
          reps: 5,
          set_type: "normal",
        },
      ],
    });
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Jul 19 2026, 12:00 UTC — Push Day (id w1): 100kg×5, failure 100kg×4");
    expect(lines[1]).toBe("Jul 12 2026, 12:00 UTC — Push Day (id w2): 95kg×5");
  });

  it("handles empty history", () => {
    expect(renderExerciseHistory({ exercise_history: [] })).toBe(
      "No logged sets for this exercise.",
    );
  });
});

describe("renderExerciseTemplate", () => {
  it("renders id, muscle groups, and equipment on one line", () => {
    expect(
      renderExerciseTemplate({
        id: "05293BCA",
        title: "Bench Press (Barbell)",
        type: "weight_reps",
        primary_muscle_group: "chest",
        secondary_muscle_groups: ["triceps"],
        equipment_category: "barbell",
        is_custom: false,
      }),
    ).toBe("05293BCA Bench Press (Barbell) — weight_reps, chest (+triceps), barbell");
  });
});

describe("renderBodyMeasurement", () => {
  it("renders only present metrics", () => {
    expect(renderBodyMeasurement({ date: "2026-07-19", weight_kg: 80.5, fat_percent: 18.5 })).toBe(
      "2026-07-19: 80.5kg, 18.5% fat",
    );
  });
});

describe("render options", () => {
  it("renders weights in pounds under imperial units", () => {
    // Hevy stores kg conversions of lb entries; 102.06kg is a clean 225lb.
    expect(renderSet({ weight_kg: 102.06, reps: 5 }, NY_IMPERIAL)).toBe("225lb×5");
  });

  it("keeps an evening workout on its local calendar day", () => {
    // 23:30 UTC Jul 19 is 19:30 EDT the same day; a UTC rendering would put
    // the end time on Jul 20.
    expect(formatTimeRange("2026-07-19T23:30:00Z", "2026-07-20T00:40:00Z", NY_IMPERIAL)).toBe(
      "Jul 19 2026, 19:30–20:40 EDT (1h10m)",
    );
  });

  it("renders body measurements in lb and inches under imperial", () => {
    expect(
      renderBodyMeasurement({ date: "2026-07-19", weight_kg: 80.5, chest_cm: 100.3 }, NY_IMPERIAL),
    ).toBe("2026-07-19: 177.5lb, chest 39.5in");
  });
});
