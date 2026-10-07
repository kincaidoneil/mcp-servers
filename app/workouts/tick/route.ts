// Called every few minutes by a scheduler (an Upstash QStash schedule; Vercel
// Hobby crons run only daily). Polls Intervals and retries failed deliveries.

import { runTick } from "../_internal/receivers";

export const maxDuration = 60;

export function GET(req: Request) {
  return runTick(req);
}
export function POST(req: Request) {
  return runTick(req);
}
