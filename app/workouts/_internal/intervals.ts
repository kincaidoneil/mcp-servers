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

const IntervalSchema = z.object({
  type: str,
  label: str,
  start_time: num,
  end_time: num,
  moving_time: num,
  elapsed_time: num,
  distance: num,
  average_speed: num,
  gap: num,
  average_gradient: num,
  total_elevation_gain: num,
  average_heartrate: num,
  max_heartrate: num,
  average_cadence: num,
  average_stride: num,
  average_watts: num,
  zone: num,
  intensity: num,
});
export type Interval = z.infer<typeof IntervalSchema>;

// Intervals' own clustering of similar intervals, e.g. "5 x 206s @ 180bpm".
const IntervalGroupSchema = z.object({
  count: num,
  moving_time: num,
  elapsed_time: num,
  distance: num,
  average_speed: num,
  gap: num,
  average_heartrate: num,
  average_cadence: num,
  average_watts: num,
  zone: num,
});

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
  trainer: z.boolean().nullish(),
  race: z.boolean().nullish(),
  distance: num,
  moving_time: num,
  elapsed_time: num,
  recording_stops: z.array(z.number()).nullish(),
  total_elevation_gain: num,
  total_elevation_loss: num,
  average_speed: num,
  gap: num,
  average_heartrate: num,
  max_heartrate: num,
  average_cadence: num,
  average_stride: num,
  average_stance_time: num,
  average_vertical_ratio: num,
  icu_average_watts: num,
  icu_weighted_avg_watts: num,
  icu_training_load: num,
  hr_load_type: str,
  trimp: num,
  icu_intensity: num,
  icu_atl: num,
  icu_ctl: num,
  icu_efficiency_factor: num,
  decoupling: num,
  icu_hrr: z.object({ hrr: num, start_bpm: num, end_bpm: num }).nullish(),
  calories: num,
  icu_rpe: num,
  session_rpe: num,
  feel: num,
  kg_lifted: num,
  // The athlete's reference points as of this activity.
  lthr: num,
  athlete_max_hr: num,
  threshold_pace: num,
  icu_ftp: num,
  icu_hr_zones: z.array(z.number()).nullish(),
  icu_hr_zone_times: z.array(z.number()).nullish(),
  pace_zone_times: z.array(z.number()).nullish(),
  gap_zone_times: z.array(z.number()).nullish(),
  has_weather: z.boolean().nullish(),
  average_weather_temp: num,
  average_feels_like: num,
  average_wind_speed: num,
  headwind_percent: num,
  interval_summary: z.array(z.string()).nullish(),
  icu_intervals: z.array(IntervalSchema).nullish(),
  icu_groups: z.array(IntervalGroupSchema).nullish(),
});
export type Activity = z.infer<typeof ActivitySchema>;

// Requested streams, sampled per recorded point. Values can be null where the
// sensor dropped out.
export const STREAM_TYPES = [
  "time",
  "distance",
  "heartrate",
  "cadence",
  "watts",
  "fixed_altitude",
] as const;
const StreamsSchema = z.array(
  z.looseObject({ type: z.string(), data: z.array(z.number().nullable()).nullish() }),
);
export type Streams = Partial<Record<(typeof STREAM_TYPES)[number], (number | null)[]>>;

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
    async getStreams(activityId: string): Promise<IntervalsResult<Streams>> {
      const result = await request(StreamsSchema, ["activity", activityId, "streams"], {
        types: STREAM_TYPES.join(","),
      });
      if (!result.ok) return result;
      const streams: Streams = {};
      for (const stream of result.value) {
        const type = STREAM_TYPES.find((t) => t === stream.type);
        if (type && stream.data) streams[type] = stream.data;
      }
      return { ok: true, value: streams };
    },
  };
}

export type IntervalsClient = ReturnType<typeof createIntervalsClient>;

export function activityUrl(activityId: string): string {
  return `${INTERVALS_ORIGIN}/activities/${encodeURIComponent(activityId)}`;
}
