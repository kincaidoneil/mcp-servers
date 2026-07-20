// Compact text renderings of Hevy API responses for the model-facing content
// block. Raw JSON wastes most of its tokens on punctuation, indentation, and
// null padding; these renderings keep every id and metric an agent needs
// (workout/routine ids for updates, template ids for building workouts) at
// roughly a tenth of the pretty-printed JSON size. Exact ISO timestamps and
// full field names remain available in structuredContent.

import type { z } from "zod";
import type {
  BodyMeasurementSchema,
  ExerciseHistorySchema,
  ExerciseTemplateSchema,
  PaginatedBodyMeasurementsSchema,
  PaginatedExerciseTemplatesSchema,
  PaginatedRoutineFoldersSchema,
  PaginatedRoutinesSchema,
  PaginatedWorkoutsSchema,
  RoutineFolderSchema,
  RoutineSchema,
  SetSchema,
  WorkoutCountSchema,
  WorkoutSchema,
} from "./schemas";

type Workout = z.infer<typeof WorkoutSchema>;
type Routine = z.infer<typeof RoutineSchema>;
type SetRow = z.infer<typeof SetSchema>;
type RoutineSet = SetRow & { rep_range?: { start?: number | null; end?: number | null } | null };

// Drop null fields recursively. Hevy pads every set with unused metrics
// (distance_meters: null, rpe: null, ...); for reads, absent means the same.
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, stripNulls(v)]),
    );
  }
  return value;
}

function present<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

// Display preferences (HEVY_TIMEZONE / HEVY_UNITS). The API itself is always
// metric UTC; these only affect the model-facing text. structuredContent
// keeps the exact metric values.
export interface RenderOptions {
  timeZone: string;
  units: "metric" | "imperial";
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = { timeZone: "UTC", units: "metric" };

const KG_PER_LB = 0.45359237;

function num(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return String(rounded);
}

function weight(kg: number, opts: RenderOptions): string {
  return opts.units === "imperial" ? `${num(kg / KG_PER_LB)}lb` : `${num(kg)}kg`;
}

function bodyLength(cm: number, opts: RenderOptions): string {
  return opts.units === "imperial" ? `${num(cm / 2.54)}in` : `${num(cm)}cm`;
}

function dayAndTime(d: Date, timeZone: string): { day: string; time: string; tz: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts["month"]} ${parts["day"]} ${parts["year"]}`,
    time: `${parts["hour"]}:${parts["minute"]}`,
    tz: parts["timeZoneName"] ?? timeZone,
  };
}

// "Jul 19 2026, 15:00–16:10 EDT (1h10m)" in the configured timezone. Falls
// back to the raw string if a timestamp fails to parse.
export function formatTimeRange(
  start: string | undefined,
  end: string | undefined,
  opts: RenderOptions = DEFAULT_RENDER_OPTIONS,
): string {
  if (!start) return "";
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return start;
  const from = dayAndTime(s, opts.timeZone);
  if (!end) return `${from.day}, ${from.time} ${from.tz}`;
  const e = new Date(end);
  if (Number.isNaN(e.getTime())) return `${from.day}, ${from.time} ${from.tz}`;
  const to = dayAndTime(e, opts.timeZone);
  const mins = Math.round((e.getTime() - s.getTime()) / 60000);
  const dur =
    mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? `${mins % 60}m` : ""}` : `${mins}m`;
  return `${from.day}, ${from.time}–${to.time} ${to.tz} (${dur})`;
}

// One set → "warmup 225lb×5 @8.5", "2000m 480s", "×12", "225lb×8–12".
export function renderSet(set: RoutineSet, opts: RenderOptions = DEFAULT_RENDER_OPTIONS): string {
  const range = set.rep_range;
  const reps =
    present(range?.start) && present(range?.end) ? `${range.start}–${range.end}` : set.reps;
  const parts: string[] = [];
  if (present(set.weight_kg))
    parts.push(`${weight(set.weight_kg, opts)}${present(reps) ? `×${reps}` : ""}`);
  else if (present(reps)) parts.push(`×${reps}`);
  if (present(set.distance_meters)) parts.push(`${set.distance_meters}m`);
  if (present(set.duration_seconds)) parts.push(`${set.duration_seconds}s`);
  if (present(set.custom_metric)) parts.push(`custom ${set.custom_metric}`);
  let out = parts.join(" ") || "(empty set)";
  if (set.type && set.type !== "normal") out = `${set.type} ${out}`;
  if (present(set.rpe)) out += ` @${set.rpe}`;
  return out;
}

// Indent continuation lines so multiline notes stay attached to their item.
function noteLines(text: string): string {
  const [first = "", ...rest] = text.split("\n");
  return [`  note: ${first}`, ...rest.map((line) => `    ${line}`)].join("\n");
}

interface RenderableExercise {
  title?: string;
  exercise_template_id?: string;
  notes?: string | null;
  rest_seconds?: number | string | null;
  supersets_id?: number | null;
  sets?: RoutineSet[];
}

function renderExercise(ex: RenderableExercise, opts: RenderOptions): string {
  const label = ex.title ?? ex.exercise_template_id ?? "exercise";
  const id = ex.exercise_template_id ? ` [${ex.exercise_template_id}]` : "";
  const superset = present(ex.supersets_id) ? ` (superset ${ex.supersets_id})` : "";
  const rest =
    present(ex.rest_seconds) && Number(ex.rest_seconds) > 0 ? ` rest ${ex.rest_seconds}s` : "";
  const sets = (ex.sets ?? []).map((s) => renderSet(s, opts)).join(", ");
  let line = `- ${label}${id}${superset}: ${sets}${rest}`;
  if (ex.notes) line += `\n${noteLines(ex.notes)}`;
  return line;
}

export function renderWorkout(w: Workout, opts: RenderOptions = DEFAULT_RENDER_OPTIONS): string {
  const lines = [`## ${w.title} — ${formatTimeRange(w.start_time, w.end_time, opts)} (id ${w.id})`];
  if (w.routine_id) lines.push(`routine: ${w.routine_id}`);
  if (w.description) lines.push(w.description);
  lines.push(...(w.exercises ?? []).map((ex) => renderExercise(ex, opts)));
  return lines.join("\n");
}

export function renderWorkoutsPage(
  page: z.infer<typeof PaginatedWorkoutsSchema>,
  opts: RenderOptions = DEFAULT_RENDER_OPTIONS,
): string {
  return [
    `page ${page.page} of ${page.page_count}`,
    ...page.workouts.map((w) => renderWorkout(w, opts)),
  ].join("\n\n");
}

export function renderWorkoutCount(value: z.infer<typeof WorkoutCountSchema>): string {
  return `${value.workout_count} workouts logged`;
}

export function renderRoutine(r: Routine, opts: RenderOptions = DEFAULT_RENDER_OPTIONS): string {
  const lines = [`## ${r.title} (id ${r.id})`];
  if (present(r.folder_id)) lines.push(`folder: ${r.folder_id}`);
  lines.push(...(r.exercises ?? []).map((ex) => renderExercise(ex, opts)));
  return lines.join("\n");
}

export function renderRoutinesPage(
  page: z.infer<typeof PaginatedRoutinesSchema>,
  opts: RenderOptions = DEFAULT_RENDER_OPTIONS,
): string {
  return [
    `page ${page.page} of ${page.page_count}`,
    ...page.routines.map((r) => renderRoutine(r, opts)),
  ].join("\n\n");
}

export function renderExerciseHistory(
  value: z.infer<typeof ExerciseHistorySchema>,
  opts: RenderOptions = DEFAULT_RENDER_OPTIONS,
): string {
  const entries = value.exercise_history;
  if (entries.length === 0) return "No logged sets for this exercise.";
  // Entries are per-set; group into one line per workout, newest data intact.
  const byWorkout = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = entry.workout_id ?? "unknown";
    const group = byWorkout.get(key);
    if (group) group.push(entry);
    else byWorkout.set(key, [entry]);
  }
  const lines: string[] = [];
  for (const [workoutId, sets] of byWorkout) {
    const first = sets[0];
    const when = formatTimeRange(first?.workout_start_time, undefined, opts);
    const rendered = sets.map((s) => renderSet({ ...s, type: s.set_type }, opts)).join(", ");
    lines.push(`${when} — ${first?.workout_title ?? "workout"} (id ${workoutId}): ${rendered}`);
  }
  return lines.join("\n");
}

export function renderExerciseTemplate(t: z.infer<typeof ExerciseTemplateSchema>): string {
  const secondary = t.secondary_muscle_groups?.length
    ? ` (+${t.secondary_muscle_groups.join(", ")})`
    : "";
  const details = [
    t.type,
    t.primary_muscle_group ? `${t.primary_muscle_group}${secondary}` : null,
    t.equipment_category,
  ]
    .filter(Boolean)
    .join(", ");
  return `${t.id} ${t.title}${t.is_custom ? " [custom]" : ""} — ${details}`;
}

export function renderExerciseTemplatesPage(
  page: z.infer<typeof PaginatedExerciseTemplatesSchema>,
): string {
  return [
    `page ${page.page} of ${page.page_count}`,
    ...page.exercise_templates.map(renderExerciseTemplate),
  ].join("\n");
}

export function renderRoutineFolder(f: z.infer<typeof RoutineFolderSchema>): string {
  return `${f.id}: ${f.title}`;
}

export function renderRoutineFoldersPage(
  value: z.infer<typeof PaginatedRoutineFoldersSchema> | z.infer<typeof RoutineFolderSchema>,
): string {
  if ("routine_folders" in value) {
    return [
      `page ${value.page} of ${value.page_count}`,
      ...value.routine_folders.map(renderRoutineFolder),
    ].join("\n");
  }
  return renderRoutineFolder(value);
}

export function renderBodyMeasurement(
  m: z.infer<typeof BodyMeasurementSchema>,
  opts: RenderOptions = DEFAULT_RENDER_OPTIONS,
): string {
  const metrics: string[] = [];
  if (present(m.weight_kg)) metrics.push(weight(m.weight_kg, opts));
  if (present(m.lean_mass_kg)) metrics.push(`lean ${weight(m.lean_mass_kg, opts)}`);
  if (present(m.fat_percent)) metrics.push(`${m.fat_percent}% fat`);
  const cm: [string, number | null | undefined][] = [
    ["neck", m.neck_cm],
    ["shoulder", m.shoulder_cm],
    ["chest", m.chest_cm],
    ["L bicep", m.left_bicep_cm],
    ["R bicep", m.right_bicep_cm],
    ["L forearm", m.left_forearm_cm],
    ["R forearm", m.right_forearm_cm],
    ["abdomen", m.abdomen],
    ["waist", m.waist],
    ["hips", m.hips],
    ["L thigh", m.left_thigh],
    ["R thigh", m.right_thigh],
    ["L calf", m.left_calf],
    ["R calf", m.right_calf],
  ];
  for (const [label, v] of cm) {
    if (v !== null && v !== undefined) metrics.push(`${label} ${bodyLength(v, opts)}`);
  }
  return `${m.date}: ${metrics.join(", ") || "(no metrics)"}`;
}

export function renderBodyMeasurementsPage(
  page: z.infer<typeof PaginatedBodyMeasurementsSchema>,
  opts: RenderOptions = DEFAULT_RENDER_OPTIONS,
): string {
  return [
    `page ${page.page} of ${page.page_count}`,
    ...page.body_measurements.map((m) => renderBodyMeasurement(m, opts)),
  ].join("\n");
}
