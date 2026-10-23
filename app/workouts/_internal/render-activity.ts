// Intervals.icu activities as text for a model asked to analyze them. Written
// for "analyze this run": totals, then the athlete's reference points so
// numbers can be judged, then the structure (Intervals' interval detection
// and per-mile splits from the streams). Lines the activity has no data for
// are left out, so a strength session or a ride renders cleanly too.

import type { Activity, Interval, Streams } from "./intervals";

export interface RenderOptions {
  units: "metric" | "imperial";
}

const MILE = 1609.344;
const MAX_INTERVAL_ROWS = 60;
const MAX_SPLITS = 50;

const FOOT_SPORTS = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]);
// Intervals' feel scale.
const FEEL = ["", "strong", "good", "normal", "poor", "weak"];

export function isFootSport(type: string | null | undefined): boolean {
  return FOOT_SPORTS.has(type ?? "");
}

function present(n: number | null | undefined): n is number {
  return n !== null && n !== undefined && Number.isFinite(n);
}

// 1:15:09, 38:03, 0:45.
export function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

function unitMeters(opts: RenderOptions) {
  return opts.units === "imperial" ? MILE : 1000;
}

function unitLabel(opts: RenderOptions) {
  return opts.units === "imperial" ? "mi" : "km";
}

function distance(meters: number, opts: RenderOptions): string {
  return `${(meters / unitMeters(opts)).toFixed(2)} ${unitLabel(opts)}`;
}

// m/s to pace per mile or km, without the unit.
function paceValue(metersPerSecond: number, opts: RenderOptions): string {
  return metersPerSecond > 0.3 ? clock(unitMeters(opts) / metersPerSecond) : "—";
}

function pace(metersPerSecond: number, opts: RenderOptions): string {
  return `${paceValue(metersPerSecond, opts)}/${unitLabel(opts)}`;
}

function speed(metersPerSecond: number, opts: RenderOptions): string {
  return opts.units === "imperial"
    ? `${(metersPerSecond * 2.23694).toFixed(1)} mph`
    : `${(metersPerSecond * 3.6).toFixed(1)} km/h`;
}

function elevation(meters: number, opts: RenderOptions): string {
  return opts.units === "imperial"
    ? `${Math.round(meters * 3.28084)} ft`
    : `${Math.round(meters)} m`;
}

function temperature(celsius: number, opts: RenderOptions): string {
  return opts.units === "imperial"
    ? `${Math.round((celsius * 9) / 5 + 32)}°F`
    : `${Math.round(celsius)}°C`;
}

// Running cadence arrives per foot (Garmin's convention); runners count steps.
function cadence(value: number, foot: boolean): string {
  return foot ? `${Math.round(value * 2)} spm` : `${Math.round(value)} rpm`;
}

export function renderActivity(
  a: Activity,
  opts: RenderOptions,
  streams: Streams | null = null,
): string {
  const foot = isFootSport(a.type);
  const lines: string[] = [`## ${a.name ?? "Activity"} — ${a.type ?? "unknown type"} (id ${a.id})`];

  const when = [
    a.start_date_local ? `${a.start_date_local.replace("T", " ").slice(0, 16)} local` : null,
  ];
  if (a.device_name) when.push(a.device_name);
  if (a.trainer) when.push("indoor/trainer");
  if (a.race) when.push("race");
  lines.push(`When: ${when.filter(Boolean).join(" · ")}`);

  const totals: string[] = [];
  if (present(a.distance) && a.distance > 0) totals.push(distance(a.distance, opts));
  if (present(a.moving_time)) {
    const paused = present(a.elapsed_time) && a.elapsed_time - a.moving_time > 60;
    totals.push(
      paused
        ? `${clock(a.moving_time)} moving / ${clock(a.elapsed_time!)} elapsed`
        : `${clock(a.moving_time)}`,
    );
  }
  if (present(a.average_speed) && present(a.distance) && a.distance > 0) {
    if (foot) {
      totals.push(`pace ${pace(a.average_speed, opts)}`);
      if (present(a.gap)) totals.push(`grade-adjusted ${pace(a.gap, opts)}`);
    } else {
      totals.push(`speed ${speed(a.average_speed, opts)}`);
    }
  }
  if (present(a.total_elevation_gain) && a.total_elevation_gain > 0) {
    totals.push(
      `+${elevation(a.total_elevation_gain, opts)}${present(a.total_elevation_loss) ? ` / −${elevation(a.total_elevation_loss, opts)}` : ""}`,
    );
  }
  if (totals.length > 0) lines.push(`Totals: ${totals.join(" · ")}`);

  if (present(a.average_heartrate)) {
    const refs = [
      present(a.lthr) ? `LTHR ${a.lthr}` : null,
      present(a.athlete_max_hr) ? `max HR ${a.athlete_max_hr}` : null,
    ].filter(Boolean);
    lines.push(
      `Heart rate: avg ${Math.round(a.average_heartrate)}${present(a.max_heartrate) ? ` · max ${a.max_heartrate}` : ""} bpm${refs.length > 0 ? ` (athlete: ${refs.join(", ")})` : ""}`,
    );
  }
  if (foot && present(a.threshold_pace) && a.threshold_pace > 0) {
    lines.push(`Threshold pace (athlete setting): ${pace(a.threshold_pace, opts)}`);
  }

  const load: string[] = [];
  if (present(a.icu_training_load)) {
    load.push(
      `training load ${a.icu_training_load}${a.hr_load_type ? ` (${a.hr_load_type})` : ""}`,
    );
  }
  if (present(a.icu_intensity)) load.push(`intensity ${Math.round(a.icu_intensity)}% of threshold`);
  if (present(a.trimp)) load.push(`TRIMP ${Math.round(a.trimp)}`);
  if (load.length > 0) lines.push(`Load: ${load.join(" · ")}`);
  if (present(a.icu_ctl) && present(a.icu_atl)) {
    lines.push(
      `After this activity: fitness (CTL) ${a.icu_ctl.toFixed(1)} · fatigue (ATL) ${a.icu_atl.toFixed(1)} · form (TSB) ${(a.icu_ctl - a.icu_atl).toFixed(1)}`,
    );
  }

  const efficiency: string[] = [];
  if (present(a.decoupling)) efficiency.push(`aerobic decoupling ${a.decoupling.toFixed(1)}%`);
  if (present(a.icu_efficiency_factor)) {
    efficiency.push(`efficiency factor ${a.icu_efficiency_factor.toFixed(2)}`);
  }
  if (a.icu_hrr && present(a.icu_hrr.hrr)) {
    efficiency.push(
      `HR recovery ${a.icu_hrr.hrr} bpm in 60 s${present(a.icu_hrr.start_bpm) && present(a.icu_hrr.end_bpm) ? ` (${a.icu_hrr.start_bpm}→${a.icu_hrr.end_bpm})` : ""}`,
    );
  }
  if (efficiency.length > 0) lines.push(`Efficiency: ${efficiency.join(" · ")}`);

  const form: string[] = [];
  if (present(a.average_cadence) && a.average_cadence > 0)
    form.push(`cadence ${cadence(a.average_cadence, foot)}`);
  if (foot && present(a.average_stride)) form.push(`stride ${a.average_stride.toFixed(2)} m`);
  if (present(a.average_stance_time))
    form.push(`ground contact ${Math.round(a.average_stance_time)} ms`);
  if (present(a.average_vertical_ratio))
    form.push(`vertical ratio ${a.average_vertical_ratio.toFixed(1)}%`);
  if (form.length > 0) lines.push(`${foot ? "Running form" : "Cadence"}: ${form.join(" · ")}`);

  if (present(a.icu_average_watts)) {
    lines.push(
      `Power: avg ${Math.round(a.icu_average_watts)} W${present(a.icu_weighted_avg_watts) ? ` · normalized ${Math.round(a.icu_weighted_avg_watts)} W` : ""}${present(a.icu_ftp) && !foot ? ` (FTP ${a.icu_ftp} W)` : ""}`,
    );
  }

  if (a.has_weather && present(a.average_weather_temp)) {
    const weather = [
      `${temperature(a.average_weather_temp, opts)}${present(a.average_feels_like) ? ` (feels ${temperature(a.average_feels_like, opts)})` : ""}`,
    ];
    if (present(a.average_wind_speed)) {
      weather.push(
        `wind ${opts.units === "imperial" ? `${Math.round(a.average_wind_speed * 2.23694)} mph` : `${Math.round(a.average_wind_speed * 3.6)} km/h`}${present(a.headwind_percent) ? `, headwind ${Math.round(a.headwind_percent)}% of the time` : ""}`,
      );
    }
    lines.push(`Weather: ${weather.join(" · ")}`);
  }

  const effort: string[] = [];
  if (present(a.icu_rpe)) effort.push(`RPE ${a.icu_rpe}/10`);
  if (present(a.feel) && FEEL[a.feel]) effort.push(`feel ${FEEL[a.feel]}`);
  if (effort.length > 0) lines.push(`Athlete-reported: ${effort.join(" · ")}`);

  if (a.icu_hr_zone_times && a.icu_hr_zone_times.some((t) => t > 0)) {
    const bounds = a.icu_hr_zones ?? [];
    const zones = a.icu_hr_zone_times
      .map((t, i) => (t > 0 ? `Z${i + 1} ${clock(t)}` : null))
      .filter(Boolean)
      .join(" · ");
    const boundText =
      bounds.length > 0
        ? ` (zone upper bounds: ${bounds.map((b, i) => `Z${i + 1} ${b}`).join(", ")} bpm)`
        : "";
    lines.push(`Time in HR zones: ${zones}${boundText}`);
  }

  if (a.icu_groups && a.icu_groups.length > 0) {
    lines.push(
      `Structure (Intervals' grouping of similar efforts): ${a.icu_groups
        .map((g) => {
          const parts = [`${g.count ?? 1}× ${clock(g.elapsed_time ?? g.moving_time ?? 0)}`];
          if (foot && present(g.gap)) parts.push(`GAP ${pace(g.gap, opts)}`);
          if (present(g.average_heartrate)) parts.push(`${Math.round(g.average_heartrate)} bpm`);
          if (present(g.average_watts)) parts.push(`${Math.round(g.average_watts)} W`);
          return parts.join(" @ ");
        })
        .join("; ")}`,
    );
  } else if (a.interval_summary && a.interval_summary.length > 0) {
    lines.push(`Structure: ${a.interval_summary.join("; ")}`);
  }

  const intervals = (a.icu_intervals ?? []).filter(
    (iv) => (iv.elapsed_time ?? iv.moving_time ?? 0) >= 10,
  );
  if (intervals.length > 1) {
    lines.push("", ...intervalTable(intervals, foot, opts));
  }

  if (streams) {
    const table = splitTable(streams, foot, opts);
    if (table.length > 0) lines.push("", ...table);
  }

  if (a.description) lines.push("", `Notes: ${a.description}`);
  return lines.join("\n");
}

function intervalTable(intervals: Interval[], foot: boolean, opts: RenderOptions): string[] {
  const header = foot
    ? `Intervals (detected by Intervals.icu; pace per ${unitLabel(opts)}): # | start | time | distance | pace | GAP | grade | HR avg/max | cadence | zone`
    : "Intervals (detected by Intervals.icu): # | start | time | distance | speed | power | HR avg/max | cadence | zone";
  const rows = intervals.slice(0, MAX_INTERVAL_ROWS).map((iv, i) => {
    const cells = [
      String(i + 1),
      present(iv.start_time) ? clock(iv.start_time) : "—",
      clock(iv.elapsed_time ?? iv.moving_time ?? 0),
      present(iv.distance) ? distance(iv.distance, opts) : "—",
    ];
    if (foot) {
      cells.push(present(iv.average_speed) ? paceValue(iv.average_speed, opts) : "—");
      cells.push(present(iv.gap) ? paceValue(iv.gap, opts) : "—");
      cells.push(
        present(iv.average_gradient)
          ? `${iv.average_gradient >= 0 ? "+" : ""}${(iv.average_gradient * 100).toFixed(1)}%`
          : "—",
      );
    } else {
      cells.push(present(iv.average_speed) ? speed(iv.average_speed, opts) : "—");
      cells.push(present(iv.average_watts) ? `${Math.round(iv.average_watts)} W` : "—");
    }
    cells.push(
      present(iv.average_heartrate)
        ? `${Math.round(iv.average_heartrate)}/${present(iv.max_heartrate) ? iv.max_heartrate : "—"}`
        : "—",
    );
    cells.push(
      present(iv.average_cadence) && iv.average_cadence > 0
        ? cadence(iv.average_cadence, foot)
        : "—",
    );
    cells.push(present(iv.zone) ? `Z${iv.zone}` : "—");
    return cells.join(" | ");
  });
  if (intervals.length > MAX_INTERVAL_ROWS) {
    rows.push(`(${intervals.length - MAX_INTERVAL_ROWS} more intervals omitted)`);
  }
  return [header, ...rows];
}

interface Split {
  meters: number;
  movingSeconds: number;
  heartrate: number | null;
  cadence: number | null;
  watts: number | null;
  gain: number;
  loss: number;
}

// Splits from the raw streams, using moving time only (samples slower than a
// slow walk are treated as paused), with time-weighted averages.
export function computeSplits(streams: Streams, splitMeters: number): Split[] {
  const time = streams.time;
  const dist = streams.distance;
  if (!time || !dist || time.length < 2 || dist.length !== time.length) return [];
  const altitude = streams.fixed_altitude;

  const splits: Split[] = [];
  let current = emptyAccumulator();
  let boundary = splitMeters;

  for (let i = 1; i < time.length; i++) {
    const t0 = time[i - 1];
    const t1 = time[i];
    const d0 = dist[i - 1];
    const d1 = dist[i];
    if (!present(t0) || !present(t1) || !present(d0) || !present(d1)) continue;
    const dt = t1 - t0;
    const dd = d1 - d0;
    if (dt <= 0) continue;

    current.meters += Math.max(dd, 0);
    if (dd / dt > 0.5) {
      current.moving += dt;
      addWeighted(current.hr, streams.heartrate?.[i], dt);
      addWeighted(current.cad, streams.cadence?.[i], dt);
      addWeighted(current.watts, streams.watts?.[i], dt);
    }
    const a0 = altitude?.[i - 1];
    const a1 = altitude?.[i];
    if (present(a0) && present(a1)) {
      if (a1 > a0) current.gain += a1 - a0;
      else current.loss += a0 - a1;
    }

    if (d1 >= boundary) {
      splits.push(finish(current));
      current = emptyAccumulator();
      boundary += splitMeters;
    }
  }
  // A trailing partial split counts once it is a tenth of a full one.
  if (current.meters >= splitMeters / 10) splits.push(finish(current));
  return splits;
}

function emptyAccumulator() {
  return {
    meters: 0,
    moving: 0,
    gain: 0,
    loss: 0,
    hr: { sum: 0, weight: 0 },
    cad: { sum: 0, weight: 0 },
    watts: { sum: 0, weight: 0 },
  };
}

function addWeighted(
  acc: { sum: number; weight: number },
  value: number | null | undefined,
  dt: number,
) {
  if (present(value) && value > 0) {
    acc.sum += value * dt;
    acc.weight += dt;
  }
}

function mean(x: { sum: number; weight: number }): number | null {
  return x.weight > 0 ? x.sum / x.weight : null;
}

function finish(acc: ReturnType<typeof emptyAccumulator>): Split {
  return {
    meters: acc.meters,
    movingSeconds: acc.moving,
    heartrate: mean(acc.hr),
    cadence: mean(acc.cad),
    watts: mean(acc.watts),
    gain: acc.gain,
    loss: acc.loss,
  };
}

function splitTable(streams: Streams, foot: boolean, opts: RenderOptions): string[] {
  const unit = unitMeters(opts);
  const total = streams.distance?.findLast(present) ?? 0;
  if (total < unit) return [];
  // One row per mile (or km) on foot, five on wheels; widen for very long efforts.
  let per = foot ? 1 : 5;
  while (total / (unit * per) > MAX_SPLITS) per *= 2;
  const splits = computeSplits(streams, unit * per);
  if (splits.length < 2) return [];

  const label = `${per === 1 ? "" : `${per} `}${unitLabel(opts)}`;
  const header = `Splits per ${label} (moving time; from the recorded streams): ${unitLabel(opts)} | time | ${foot ? "pace" : "speed"} | HR | cadence | ${streams.watts ? "power | " : ""}elevation`;
  let covered = 0;
  const rows = splits.map((s) => {
    covered += s.meters;
    const cells = [
      (covered / unit).toFixed(s.meters < unit * per * 0.95 ? 2 : 0),
      clock(s.movingSeconds),
      s.movingSeconds > 0
        ? foot
          ? paceValue(s.meters / s.movingSeconds, opts)
          : speed(s.meters / s.movingSeconds, opts)
        : "—",
      s.heartrate !== null ? String(Math.round(s.heartrate)) : "—",
      s.cadence !== null ? cadence(s.cadence, foot) : "—",
    ];
    if (streams.watts) cells.push(s.watts !== null ? `${Math.round(s.watts)} W` : "—");
    cells.push(`+${elevation(s.gain, opts)} / −${elevation(s.loss, opts)}`);
    return cells.join(" | ");
  });
  return [header, ...rows];
}

// One line per activity for listings.
export function activityLine(a: Activity, opts: RenderOptions): string {
  const foot = isFootSport(a.type);
  const parts = [
    a.start_date_local?.replace("T", " ").slice(0, 16) ?? a.start_date ?? "?",
    "intervals",
    `${a.name ?? "Activity"} (${a.type ?? "?"})`,
  ];
  if (present(a.distance) && a.distance > 0) parts.push(distance(a.distance, opts));
  if (present(a.moving_time)) parts.push(clock(a.moving_time));
  if (foot && present(a.average_speed) && present(a.distance) && a.distance > 0) {
    parts.push(pace(a.average_speed, opts));
  }
  if (present(a.average_heartrate)) parts.push(`${Math.round(a.average_heartrate)} bpm`);
  if (present(a.icu_training_load)) parts.push(`load ${a.icu_training_load}`);
  parts.push(`id ${a.id}`);
  return parts.join(" · ");
}
