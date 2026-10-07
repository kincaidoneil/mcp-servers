// Thin client for the Intervals.icu API (https://intervals.icu/api-docs.html),
// shaped like the Hevy client: every call returns a result union.

import { z } from "zod";
import type { IntervalsCredential } from "./credentials";

const INTERVALS_ORIGIN = "https://intervals.icu";

export type IntervalsErrorCode =
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "invalid_response"
  | "http_error"
  | "network";

export type IntervalsResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: IntervalsErrorCode; status: number | null; message: string };

const num = z.number().nullish();
const str = z.string().nullish();

// Only the fields this bridge reads. Intervals returns well over a hundred.
export const ActivitySchema = z.object({
  id: z.string(),
  name: str,
  type: str,
  description: str,
  start_date: str,
  start_date_local: str,
  timezone: str,
  analyzed: str,
  created: str,
  source: str,
  device_name: str,
  distance: num,
  moving_time: num,
  elapsed_time: num,
  total_elevation_gain: num,
  average_heartrate: num,
  max_heartrate: num,
  average_cadence: num,
  average_speed: num,
  icu_average_watts: num,
  icu_weighted_avg_watts: num,
  icu_training_load: num,
  icu_intensity: num,
  icu_atl: num,
  icu_ctl: num,
  icu_efficiency_factor: num,
  decoupling: num,
  calories: num,
  icu_rpe: num,
  feel: num,
  kg_lifted: num,
  icu_hr_zone_times: z.array(z.number()).nullish(),
  interval_summary: z.array(z.string()).nullish(),
  icu_intervals: z
    .array(
      z.object({
        type: str,
        label: str,
        moving_time: num,
        distance: num,
        average_heartrate: num,
        average_watts: num,
        average_speed: num,
      }),
    )
    .nullish(),
});
export type Activity = z.infer<typeof ActivitySchema>;

const AthleteSchema = z.object({ id: z.string(), name: str });

export function createIntervalsClient(credential: IntervalsCredential) {
  const authorization =
    credential.kind === "api_key"
      ? `Basic ${Buffer.from(`API_KEY:${credential.apiKey}`).toString("base64")}`
      : `Bearer ${credential.accessToken}`;

  async function request<Schema extends z.ZodType>(
    schema: Schema,
    segments: string[],
    query: Record<string, string> = {},
  ): Promise<IntervalsResult<z.infer<Schema>>> {
    const url = new URL(INTERVALS_ORIGIN);
    url.pathname = `/api/v1/${segments.map(encodeURIComponent).join("/")}`;
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization, accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      return {
        ok: false,
        code: "network",
        status: null,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const code: IntervalsErrorCode =
        response.status === 401 || response.status === 403
          ? "unauthorized"
          : response.status === 404
            ? "not_found"
            : response.status === 429
              ? "rate_limited"
              : "http_error";
      return {
        ok: false,
        code,
        status: response.status,
        message: text.slice(0, 500) || response.statusText,
      };
    }
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid_response",
        status: response.status,
        message: `unexpected Intervals response shape: ${parsed.error.message.slice(0, 500)}`,
      };
    }
    return { ok: true, value: parsed.data };
  }

  return {
    // "0" means the athlete the credential belongs to.
    getAthlete() {
      return request(AthleteSchema, ["athlete", "0"]);
    },
    listActivities(oldest: string, newest: string) {
      return request(z.array(ActivitySchema), ["athlete", "0", "activities"], { oldest, newest });
    },
    getActivity(activityId: string) {
      return request(ActivitySchema, ["activity", activityId], { intervals: "true" });
    },
  };
}

export type IntervalsClient = ReturnType<typeof createIntervalsClient>;

export function activityUrl(activityId: string): string {
  return `${INTERVALS_ORIGIN}/activities/${encodeURIComponent(activityId)}`;
}

interface RenderOptions {
  units: "metric" | "imperial";
}

// Plain-text summary for the model. Skips anything the activity lacks, so a
// strength session without GPS reads as cleanly as a run.
export function renderActivity(a: Activity, opts: RenderOptions, detail = false): string {
  const imperial = opts.units === "imperial";
  const lines = [
    `## ${a.name ?? "Activity"} — ${a.type ?? "unknown type"}, ${a.start_date_local ?? a.start_date ?? "unknown start"} (id ${a.id})`,
  ];
  const facts: string[] = [];
  if (a.distance) {
    facts.push(
      imperial
        ? `distance ${(a.distance / 1609.344).toFixed(2)} mi`
        : `distance ${(a.distance / 1000).toFixed(2)} km`,
    );
  }
  if (a.moving_time) facts.push(`moving ${formatDuration(a.moving_time)}`);
  if (a.elapsed_time && a.elapsed_time !== a.moving_time) {
    facts.push(`elapsed ${formatDuration(a.elapsed_time)}`);
  }
  if (a.average_speed && a.distance && isFootSport(a.type)) {
    facts.push(`pace ${formatPace(a.average_speed, imperial)}`);
  }
  if (a.total_elevation_gain) {
    facts.push(
      imperial
        ? `elevation +${Math.round(a.total_elevation_gain * 3.28084)} ft`
        : `elevation +${Math.round(a.total_elevation_gain)} m`,
    );
  }
  if (a.average_heartrate) {
    facts.push(
      `HR avg ${Math.round(a.average_heartrate)}${a.max_heartrate ? ` / max ${a.max_heartrate}` : ""}`,
    );
  }
  if (a.icu_average_watts) {
    facts.push(
      `power avg ${Math.round(a.icu_average_watts)} W${a.icu_weighted_avg_watts ? ` / NP ${Math.round(a.icu_weighted_avg_watts)} W` : ""}`,
    );
  }
  if (a.average_cadence) facts.push(`cadence ${Math.round(a.average_cadence)}`);
  if (a.icu_training_load !== null && a.icu_training_load !== undefined) {
    facts.push(`load ${a.icu_training_load}`);
  }
  if (a.icu_intensity) facts.push(`intensity ${Math.round(a.icu_intensity)}%`);
  if (a.decoupling !== null && a.decoupling !== undefined) {
    facts.push(`decoupling ${a.decoupling.toFixed(1)}%`);
  }
  if (a.icu_efficiency_factor) facts.push(`EF ${a.icu_efficiency_factor.toFixed(2)}`);
  if (a.kg_lifted) facts.push(`lifted ${Math.round(a.kg_lifted)} kg`);
  if (a.calories) facts.push(`${a.calories} kcal`);
  if (a.icu_rpe) facts.push(`RPE ${a.icu_rpe}`);
  if (a.feel) facts.push(`feel ${a.feel}/5`);
  if (facts.length > 0) lines.push(facts.join(" · "));

  if (
    a.icu_ctl !== null &&
    a.icu_ctl !== undefined &&
    a.icu_atl !== null &&
    a.icu_atl !== undefined
  ) {
    lines.push(
      `fitness ${a.icu_ctl.toFixed(1)}, fatigue ${a.icu_atl.toFixed(1)}, form ${(a.icu_ctl - a.icu_atl).toFixed(1)} after this activity`,
    );
  }
  if (a.icu_hr_zone_times && a.icu_hr_zone_times.some((t) => t > 0)) {
    lines.push(
      `time in HR zones: ${a.icu_hr_zone_times.map((t, i) => `Z${i + 1} ${formatDuration(t)}`).join(", ")}`,
    );
  }
  if (a.interval_summary && a.interval_summary.length > 0) {
    lines.push(`intervals: ${a.interval_summary.join("; ")}`);
  }
  if (detail && a.icu_intervals && a.icu_intervals.length > 0) {
    lines.push(
      ...a.icu_intervals.map((iv, i) => {
        const parts = [`${i + 1}. ${iv.label ?? iv.type ?? "interval"}`];
        if (iv.moving_time) parts.push(formatDuration(iv.moving_time));
        if (iv.distance) {
          parts.push(
            imperial
              ? `${(iv.distance / 1609.344).toFixed(2)} mi`
              : `${(iv.distance / 1000).toFixed(2)} km`,
          );
        }
        if (iv.average_speed && isFootSport(a.type))
          parts.push(formatPace(iv.average_speed, imperial));
        if (iv.average_watts) parts.push(`${Math.round(iv.average_watts)} W`);
        if (iv.average_heartrate) parts.push(`${Math.round(iv.average_heartrate)} bpm`);
        return parts.join(" · ");
      }),
    );
  }
  if (a.device_name) lines.push(`device: ${a.device_name}`);
  if (a.description) lines.push(a.description);
  return lines.join("\n");
}

function isFootSport(type: string | null | undefined): boolean {
  return (
    type === "Run" ||
    type === "TrailRun" ||
    type === "VirtualRun" ||
    type === "Walk" ||
    type === "Hike"
  );
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(rest).padStart(2, "0")}s`;
}

function formatPace(metersPerSecond: number, imperial: boolean): string {
  const secondsPerUnit = Math.round((imperial ? 1609.344 : 1000) / metersPerSecond);
  const m = Math.floor(secondsPerUnit / 60);
  const s = secondsPerUnit % 60;
  return `${m}:${String(s).padStart(2, "0")}/${imperial ? "mi" : "km"}`;
}
