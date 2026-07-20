import { describe, expect, it } from "vitest";
import { createHevyClient } from "../client";
import {
  HEVY_BASE,
  HttpResponse,
  http,
  setupHevyMockServer,
  TEST_API_KEY,
  workoutFixture,
} from "./test-helpers";

const server = setupHevyMockServer();
const client = createHevyClient(TEST_API_KEY);

describe("createHevyClient", () => {
  it("sends the api-key header and pagination query params", async () => {
    let capturedKey: string | null = null;
    let capturedQuery: string | null = null;
    server.use(
      http.get(`${HEVY_BASE}/workouts`, ({ request }) => {
        capturedKey = request.headers.get("api-key");
        capturedQuery = new URL(request.url).search;
        return HttpResponse.json({
          page: 2,
          page_count: 5,
          workouts: [workoutFixture({ id: "b459cba5-cd6d-463c-abd6-54f8eafcadcb" })],
        });
      }),
    );

    const result = await client.listWorkouts({ page: 2, pageSize: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workouts[0]?.title).toBe("Morning Workout");
    expect(capturedKey).toBe(TEST_API_KEY);
    expect(capturedQuery).toBe("?page=2&pageSize=10");
  });

  it("maps 401 to unauthorized", async () => {
    server.use(
      http.get(`${HEVY_BASE}/workouts/count`, () =>
        HttpResponse.json({ error: "invalid api key" }, { status: 401 }),
      ),
    );
    const result = await client.getWorkoutCount();
    expect(result).toMatchObject({ ok: false, code: "unauthorized", status: 401 });
  });

  it("maps 404 to not_found", async () => {
    server.use(
      http.get(`${HEVY_BASE}/workouts/:id`, () => new HttpResponse(null, { status: 404 })),
    );
    const result = await client.getWorkout("b459cba5-cd6d-463c-abd6-54f8eafcadcb");
    expect(result).toMatchObject({ ok: false, code: "not_found", status: 404 });
  });

  it("maps 409 to conflict", async () => {
    server.use(
      http.post(`${HEVY_BASE}/body_measurements`, () =>
        HttpResponse.json({ error: "already exists" }, { status: 409 }),
      ),
    );
    const result = await client.createBodyMeasurement({ date: "2026-07-19", weight_kg: 80 });
    expect(result).toMatchObject({ ok: false, code: "conflict", status: 409 });
  });

  it("maps 429 to rate_limited", async () => {
    server.use(
      http.get(`${HEVY_BASE}/workouts/count`, () => new HttpResponse(null, { status: 429 })),
    );
    const result = await client.getWorkoutCount();
    expect(result).toMatchObject({ ok: false, code: "rate_limited", status: 429 });
  });

  it("maps malformed JSON to invalid_response", async () => {
    server.use(
      http.get(`${HEVY_BASE}/workouts/count`, () => new HttpResponse("not json", { status: 200 })),
    );
    const result = await client.getWorkoutCount();
    expect(result).toMatchObject({ ok: false, code: "invalid_response" });
  });

  it("maps schema mismatches to invalid_response", async () => {
    server.use(
      http.get(`${HEVY_BASE}/workouts/count`, () => HttpResponse.json({ unexpected: "shape" })),
    );
    const result = await client.getWorkoutCount();
    expect(result).toMatchObject({ ok: false, code: "invalid_response" });
  });

  it("accepts empty success bodies (body measurement create)", async () => {
    server.use(
      http.post(`${HEVY_BASE}/body_measurements`, () => new HttpResponse(null, { status: 200 })),
    );
    const result = await client.createBodyMeasurement({ date: "2026-07-19", weight_kg: 80 });
    expect(result.ok).toBe(true);
  });

  it("percent-encodes hostile path segments so they stay on the Hevy origin", async () => {
    let capturedPath: string | null = null;
    server.use(
      http.get(`${HEVY_BASE}/workouts/:id`, ({ request }) => {
        capturedPath = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 404 });
      }),
    );
    const result = await client.getWorkout("//attacker.example/x?y=z");
    // The hostile value never becomes structure: no new host, no new path
    // segments, no query string. It is one encoded segment under /v1/workouts.
    expect(capturedPath).toBe("/v1/workouts/%2F%2Fattacker.example%2Fx%3Fy%3Dz");
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });

  it("unwraps the { routine } envelope on get-routine", async () => {
    const routineId = "0a72f4c1-9a20-45d3-8b6a-2f9f8d7f4b11";
    server.use(
      http.get(`${HEVY_BASE}/routines/:id`, () =>
        // Hevy wraps this one endpoint's response in an envelope.
        HttpResponse.json({ routine: { id: routineId, title: "Upper Body" } }),
      ),
    );
    const result = await client.getRoutine(routineId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(routineId);
    expect(result.value.title).toBe("Upper Body");
  });

  it("accepts a bare routine response on create", async () => {
    server.use(
      http.post(`${HEVY_BASE}/routines`, () =>
        HttpResponse.json(
          { id: "0a72f4c1-9a20-45d3-8b6a-2f9f8d7f4b11", title: "Upper Body" },
          { status: 201 },
        ),
      ),
    );
    const result = await client.createRoutine({
      title: "Upper Body",
      folder_id: null,
      exercises: [{ exercise_template_id: "05293BCA", sets: [{ type: "normal", reps: 8 }] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("Upper Body");
  });

  it("wraps workout create payloads in { workout }", async () => {
    let capturedBody: unknown = null;
    server.use(
      http.post(`${HEVY_BASE}/workouts`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(workoutFixture({ id: "b459cba5-cd6d-463c-abd6-54f8eafcadcb" }), {
          status: 201,
        });
      }),
    );
    const workout = {
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
    const result = await client.createWorkout(workout);
    expect(result.ok).toBe(true);
    expect(capturedBody).toEqual({ workout });
  });
});
