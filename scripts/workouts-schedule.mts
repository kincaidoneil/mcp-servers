/* oxlint-disable no-console -- a CLI script reports on the console */
// Create or update the QStash schedule that calls /workouts/tick every five
// minutes. Idempotent: the fixed schedule id makes a rerun replace the
// existing schedule.
//
//   node --env-file=.env.local scripts/workouts-schedule.mts
//
// Needs QSTASH_TOKEN (and QSTASH_URL outside the default region),
// PUBLIC_BASE_URL, and WORKOUTS_TICK_SECRET.

const SCHEDULE_ID = "workouts-tick";
const CRON = "*/5 * * * *";

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }
  return value;
}

const qstash = (process.env["QSTASH_URL"] ?? "https://qstash.upstash.io").replace(/\/$/, "");
const destination = `${env("PUBLIC_BASE_URL").replace(/\/$/, "")}/workouts/tick`;

const response = await fetch(`${qstash}/v2/schedules/${destination}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${env("QSTASH_TOKEN")}`,
    "upstash-cron": CRON,
    "upstash-schedule-id": SCHEDULE_ID,
    "upstash-method": "POST",
    "upstash-retries": "0",
    "upstash-forward-authorization": `Bearer ${env("WORKOUTS_TICK_SECRET")}`,
  },
});
const body = await response.text();
if (!response.ok) {
  console.error(`QStash answered ${response.status}: ${body}`);
  process.exit(1);
}
console.log(`Schedule ${SCHEDULE_ID}: POST ${destination} on "${CRON}". ${body}`);
