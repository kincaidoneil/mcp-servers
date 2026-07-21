import { describe, expect, it } from "vitest";
import { createHevyClient } from "../client";
import { toToolResult } from "../server";
import {
  ListBodyMeasurementsInputSchema,
  logBodyMeasurement,
  LogBodyMeasurementInputSchema,
} from "../tools/body-measurements";
import { ListExerciseTemplatesInputSchema } from "../tools/exercise-templates";
import { RoutineSchema } from "../schemas";
import { listRoutineFolders, ListRoutineFoldersInputSchema } from "../tools/routine-folders";
import { saveRoutine, SaveRoutineInputSchema } from "../tools/routines";
import {
  getExerciseHistory,
  GetExerciseHistoryInputSchema,
  GetWorkoutInputSchema,
  ListWorkoutsInputSchema,
  listWorkouts,
  saveWorkout,
  SaveWorkoutInputSchema,
} from "../tools/workouts";
import {
  HEVY_BASE,
  HttpResponse,
  http,
  routineFixture,
  setupHevyMockServer,
  TEST_API_KEY,
  workoutFixture,
} from "./test-helpers";

const server = setupHevyMockServer();
const client = createHevyClient(TEST_API_KEY);

const WORKOUT_UUID = "b459cba5-cd6d-463c-abd6-54f8eafcadcb";
const ROUTINE_UUID = "0a72f4c1-9a20-45d3-8b6a-2f9f8d7f4b11";

const workoutInput = {
  title: "Leg Day",
  start_time: "2026-07-19T12:00:00Z",
  end_time: "2026-07-19T13:00:00Z",
  exercises: [
    {
      exercise_template_id: "05293BCA",
      sets: [{ type: "normal" as const, weight_kg: 100, reps: 5 }],
    },
  ],
};

describe("input schemas", () => {
  it("enforce the 10-item page cap on workouts and 100 on exercise templates", () => {
    expect(ListWorkoutsInputSchema.safeParse({ pageSize: 11 }).success).toBe(false);
    expect(ListWorkoutsInputSchema.safeParse({ pageSize: 10 }).success).toBe(true);
    expect(ListExerciseTemplatesInputSchema.safeParse({ pageSize: 100 }).success).toBe(true);
    expect(ListExerciseTemplatesInputSchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });

  it("apply pagination defaults", () => {
    expect(ListWorkoutsInputSchema.parse({})).toEqual({ page: 1, pageSize: 10 });
    expect(ListBodyMeasurementsInputSchema.parse({})).toEqual({ page: 1, pageSize: 10 });
  });

  it("reject hostile ids before they reach a URL", () => {
    expect(GetWorkoutInputSchema.safeParse({ workout_id: "//attacker.example/x" }).success).toBe(
      false,
    );
    expect(GetWorkoutInputSchema.safeParse({ workout_id: "../secrets" }).success).toBe(false);
    expect(GetWorkoutInputSchema.safeParse({ workout_id: WORKOUT_UUID }).success).toBe(true);
    expect(GetExerciseHistoryInputSchema.safeParse({ exercise_template_id: "a/b" }).success).toBe(
      false,
    );
    expect(
      GetExerciseHistoryInputSchema.safeParse({ exercise_template_id: "05293BCA" }).success,
    ).toBe(true);
  });

  it("reject malformed measurement dates", () => {
    expect(LogBodyMeasurementInputSchema.safeParse({ date: "07/19/2026" }).success).toBe(false);
    expect(
      LogBodyMeasurementInputSchema.safeParse({ date: "2026-07-19", weight_kg: 80 }).success,
    ).toBe(true);
  });
});

describe("workout tools", () => {
  it("lists workouts with pagination passthrough", async () => {
    let query: string | null = null;
    server.use(
      http.get(`${HEVY_BASE}/workouts`, ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({
          page: 3,
          page_count: 7,
          workouts: [workoutFixture({ id: WORKOUT_UUID })],
        });
      }),
    );
    const input = ListWorkoutsInputSchema.parse({ page: 3, pageSize: 5 });
    const result = await listWorkouts(input, client);
    expect(result.ok).toBe(true);
    expect(query).toBe("?page=3&pageSize=5");
  });

  it("save-workout POSTs when workout_id is omitted", async () => {
    let method: string | null = null;
    let body: unknown = null;
    server.use(
      http.post(`${HEVY_BASE}/workouts`, async ({ request }) => {
        method = request.method;
        body = await request.json();
        return HttpResponse.json(workoutFixture({ id: WORKOUT_UUID }), { status: 201 });
      }),
    );
    const input = SaveWorkoutInputSchema.parse(workoutInput);
    const result = await saveWorkout(input, client);
    expect(result.ok).toBe(true);
    expect(method).toBe("POST");
    expect(body).toMatchObject({ workout: { title: "Leg Day" } });
  });

  it("normalizes a fetched supersets_id back to superset_id on save", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${HEVY_BASE}/workouts`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(workoutFixture({ id: WORKOUT_UUID }), { status: 201 });
      }),
    );
    // The read tools return supersets_id; the save schema also accepts it so a
    // fetched workout round-trips. The outgoing body must use superset_id.
    const input = SaveWorkoutInputSchema.parse({
      ...workoutInput,
      exercises: [
        {
          exercise_template_id: "05293BCA",
          supersets_id: 1,
          sets: [{ type: "normal", weight_kg: 100, reps: 5 }],
        },
      ],
    });
    const result = await saveWorkout(input, client);
    expect(result.ok).toBe(true);
    const ex = (body as { workout: { exercises: Record<string, unknown>[] } }).workout.exercises[0];
    expect(ex?.["superset_id"]).toBe(1);
    expect(ex).not.toHaveProperty("supersets_id");
  });

  it("save-workout PUTs to the workout when workout_id is present", async () => {
    let path: string | null = null;
    server.use(
      http.put(`${HEVY_BASE}/workouts/:id`, ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json(workoutFixture({ id: WORKOUT_UUID }));
      }),
    );
    const input = SaveWorkoutInputSchema.parse({ ...workoutInput, workout_id: WORKOUT_UUID });
    const result = await saveWorkout(input, client);
    expect(result.ok).toBe(true);
    expect(path).toBe(`/v1/workouts/${WORKOUT_UUID}`);
  });

  // Serve workouts newest-first across pages, recording which pages were hit.
  function pagedWorkouts(pages: string[][]) {
    const requested: number[] = [];
    server.use(
      http.get(`${HEVY_BASE}/workouts`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
        requested.push(page);
        const times = pages[page - 1] ?? [];
        return HttpResponse.json({
          page,
          page_count: pages.length,
          workouts: times.map((start_time, i) =>
            workoutFixture({ id: `w-${page}-${i}`, start_time }),
          ),
        });
      }),
    );
    return requested;
  }

  it("filters by since/until and early-exits once a page falls before since", async () => {
    const requested = pagedWorkouts([
      ["2026-06-20T12:00:00Z", "2026-06-15T12:00:00Z"],
      ["2026-06-05T12:00:00Z", "2026-06-01T12:00:00Z"],
      ["2026-05-20T12:00:00Z"],
    ]);
    const input = ListWorkoutsInputSchema.parse({ since: "2026-06-10", until: "2026-06-18" });
    const result = await listWorkouts(input, client);
    expect(result.ok).toBe(true);
    if (!result.ok || "page_count" in result.value) throw new Error("expected range result");
    // 06-20 is above until, 06-15 is in range; page 2 is all before since → stop.
    expect(result.value.workouts.map((w) => w.start_time)).toEqual(["2026-06-15T12:00:00Z"]);
    expect(result.value.truncated).toBe(false);
    expect(requested).toEqual([1, 2]);
  });

  it("stops at the limit without fetching further pages", async () => {
    const requested = pagedWorkouts([
      ["2026-06-20T12:00:00Z", "2026-06-19T12:00:00Z"],
      ["2026-06-18T12:00:00Z"],
    ]);
    const input = ListWorkoutsInputSchema.parse({ since: "2026-01-01", limit: 1 });
    const result = await listWorkouts(input, client);
    expect(result.ok).toBe(true);
    if (!result.ok || "page_count" in result.value) throw new Error("expected range result");
    expect(result.value.workouts).toHaveLength(1);
    expect(requested).toEqual([1]);
  });

  it("flags truncation when the page-scan cap is hit", async () => {
    // 12 pages available, all in range; the scan stops at 10.
    const pages = Array.from({ length: 12 }, () => ["2020-01-01T12:00:00Z"]);
    const requested = pagedWorkouts(pages);
    const input = ListWorkoutsInputSchema.parse({ since: "2000-01-01" });
    const result = await listWorkouts(input, client);
    expect(result.ok).toBe(true);
    if (!result.ok || "page_count" in result.value) throw new Error("expected range result");
    expect(result.value.truncated).toBe(true);
    expect(result.value.scanned).toBe(10);
    expect(requested).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("returns a raw page when no filter is given", async () => {
    let query: string | null = null;
    server.use(
      http.get(`${HEVY_BASE}/workouts`, ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ page: 1, page_count: 4, workouts: [] });
      }),
    );
    const result = await listWorkouts(ListWorkoutsInputSchema.parse({ page: 2 }), client);
    expect(result.ok).toBe(true);
    if (!result.ok || !("page_count" in result.value)) throw new Error("expected paged result");
    expect(query).toBe("?page=2&pageSize=10");
  });

  it("passes exercise history date filters through", async () => {
    let query: URLSearchParams | null = null;
    server.use(
      http.get(`${HEVY_BASE}/exercise_history/:id`, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({ exercise_history: [] });
      }),
    );
    const input = GetExerciseHistoryInputSchema.parse({
      exercise_template_id: "05293BCA",
      start_date: "2026-01-01T00:00:00Z",
    });
    const result = await getExerciseHistory(input, client);
    expect(result.ok).toBe(true);
    expect(query!.get("start_date")).toBe("2026-01-01T00:00:00Z");
    expect(query!.has("end_date")).toBe(false);
  });
});

describe("routine tools", () => {
  it("save-routine sends folder_id on create but not on update", async () => {
    let createBody: unknown = null;
    let updateBody: unknown = null;
    server.use(
      http.post(`${HEVY_BASE}/routines`, async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json(routineFixture({ id: ROUTINE_UUID }), { status: 201 });
      }),
      http.put(`${HEVY_BASE}/routines/:id`, async ({ request }) => {
        updateBody = await request.json();
        return HttpResponse.json(routineFixture({ id: ROUTINE_UUID }));
      }),
    );
    const routine = {
      title: "Upper Body",
      exercises: [
        { exercise_template_id: "05293BCA", sets: [{ type: "normal" as const, reps: 8 }] },
      ],
    };
    const created = await saveRoutine(
      SaveRoutineInputSchema.parse({ ...routine, folder_id: 42 }),
      client,
    );
    expect(created.ok).toBe(true);
    expect(createBody).toMatchObject({ routine: { title: "Upper Body", folder_id: 42 } });

    const updated = await saveRoutine(
      SaveRoutineInputSchema.parse({ ...routine, routine_id: ROUTINE_UUID, folder_id: 42 }),
      client,
    );
    expect(updated.ok).toBe(true);
    expect((updateBody as { routine: Record<string, unknown> }).routine).not.toHaveProperty(
      "folder_id",
    );
  });

  it("normalizes a fetched supersets_id back to superset_id on save", async () => {
    let createBody: unknown = null;
    server.use(
      http.post(`${HEVY_BASE}/routines`, async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json(routineFixture({ id: ROUTINE_UUID }), { status: 201 });
      }),
    );
    const input = SaveRoutineInputSchema.parse({
      title: "Upper Body",
      exercises: [
        {
          exercise_template_id: "05293BCA",
          supersets_id: 2,
          sets: [{ type: "normal" as const, reps: 8 }],
        },
      ],
    });
    const result = await saveRoutine(input, client);
    expect(result.ok).toBe(true);
    const ex = (createBody as { routine: { exercises: Record<string, unknown>[] } }).routine
      .exercises[0];
    expect(ex?.["superset_id"]).toBe(2);
    expect(ex).not.toHaveProperty("supersets_id");
  });
});

describe("response schemas", () => {
  it("keeps target rep_range on routine response sets", () => {
    // Routine GETs return rep_range on each set; it must survive parsing so
    // reads render the range and fetch-edit-save preserves it.
    const parsed = RoutineSchema.parse({
      id: ROUTINE_UUID,
      title: "Upper Body",
      exercises: [
        {
          exercise_template_id: "05293BCA",
          sets: [{ type: "normal", weight_kg: 100, rep_range: { start: 8, end: 12 } }],
        },
      ],
    });
    expect(parsed.exercises?.[0]?.sets?.[0]?.rep_range).toEqual({ start: 8, end: 12 });
  });
});

describe("routine folder tools", () => {
  it("fetches a single folder when folder_id is passed", async () => {
    let path: string | null = null;
    server.use(
      http.get(`${HEVY_BASE}/routine_folders/:id`, ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json({ id: 42, title: "Push Pull" });
      }),
    );
    const input = ListRoutineFoldersInputSchema.parse({ folder_id: 42 });
    const result = await listRoutineFolders(input, client);
    expect(result.ok).toBe(true);
    expect(path).toBe("/v1/routine_folders/42");
  });
});

describe("body measurement tools", () => {
  it("surfaces a 409 as a conflict error result", async () => {
    server.use(
      http.post(`${HEVY_BASE}/body_measurements`, () =>
        HttpResponse.json({ error: "exists" }, { status: 409 }),
      ),
    );
    const input = LogBodyMeasurementInputSchema.parse({ date: "2026-07-19", weight_kg: 80 });
    const result = await logBodyMeasurement(input, client);
    expect(result).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("toToolResult", () => {
  it("uses the tool's renderer for text and null-stripped JSON for structuredContent", () => {
    const rendered = toToolResult(
      { ok: true, value: { workout_count: 42, extra: null } },
      () => "42 workouts logged",
    );
    expect(rendered.isError).toBeUndefined();
    expect(rendered.structuredContent).toEqual({ workout_count: 42 });
    expect(rendered.content[0]?.text).toBe("42 workouts logged");
  });

  it("falls back to compact null-stripped JSON without a renderer", () => {
    const rendered = toToolResult({ ok: true, value: { workout_count: 42, extra: null } });
    expect(rendered.content[0]?.text).toBe('{"workout_count":42}');
  });

  it("renders empty ok results (measurement create) without structure errors", () => {
    const rendered = toToolResult({ ok: true, value: null });
    expect(rendered.isError).toBeUndefined();
    expect(rendered.structuredContent).toEqual({ ok: true });
  });

  it("tells the user to reconnect on unauthorized", () => {
    const rendered = toToolResult({
      ok: false,
      code: "unauthorized",
      status: 401,
      message: "invalid api key",
    });
    expect(rendered.isError).toBe(true);
    expect(rendered.content[0]?.text).toContain("reconnect");
  });

  it("explains conflicts in terms of duplicate dates", () => {
    const rendered = toToolResult({ ok: false, code: "conflict", status: 409, message: "exists" });
    expect(rendered.isError).toBe(true);
    expect(rendered.content[0]?.text).toContain("already");
  });
});
