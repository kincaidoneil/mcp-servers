import { http, HttpResponse, type HttpHandler } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

export function setupHevyMockServer(initialHandlers: HttpHandler[] = []) {
  const server = setupServer(...initialHandlers);
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

export const HEVY_BASE = "https://api.hevyapp.com/v1";

export const TEST_API_KEY = "11111111-2222-3333-4444-555555555555";

export function workoutFixture(opts: { id: string; title?: string }) {
  return {
    id: opts.id,
    title: opts.title ?? "Morning Workout",
    description: null,
    start_time: "2026-07-19T12:00:00Z",
    end_time: "2026-07-19T13:00:00Z",
    created_at: "2026-07-19T13:00:05Z",
    updated_at: "2026-07-19T13:00:05Z",
    exercises: [
      {
        index: 0,
        title: "Bench Press (Barbell)",
        notes: null,
        exercise_template_id: "05293BCA",
        supersets_id: null,
        sets: [{ index: 0, type: "normal", weight_kg: 100, reps: 5, rpe: 8 }],
      },
    ],
  };
}

export function routineFixture(opts: { id: string; title?: string }) {
  return {
    id: opts.id,
    title: opts.title ?? "Upper Body",
    folder_id: null,
    created_at: "2026-07-01T12:00:00Z",
    updated_at: "2026-07-01T12:00:00Z",
    exercises: [
      {
        index: 0,
        title: "Bench Press (Barbell)",
        rest_seconds: 90,
        notes: null,
        exercise_template_id: "05293BCA",
        supersets_id: null,
        sets: [{ index: 0, type: "normal", weight_kg: 100, reps: 8 }],
      },
    ],
  };
}

export function exerciseTemplateFixture(opts: { id: string; title?: string }) {
  return {
    id: opts.id,
    title: opts.title ?? "Bench Press (Barbell)",
    type: "weight_reps",
    primary_muscle_group: "chest",
    secondary_muscle_groups: ["triceps"],
    equipment_category: "barbell",
    is_custom: false,
  };
}

export function userInfoFixture(opts: { id?: string; name?: string } = {}) {
  return {
    data: {
      id: opts.id ?? "9c465af3-de7d-42bc-9c7c-f0170396358b",
      name: opts.name ?? "Kincaid",
      url: "https://hevy.com/user/kincaid",
    },
  };
}

export { http, HttpResponse };
