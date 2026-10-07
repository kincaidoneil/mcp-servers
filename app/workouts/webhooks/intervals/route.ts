import { after } from "next/server";
import { deliverAll } from "../../_internal/events/dispatch";
import { receiveIntervalsWebhook } from "../../_internal/receivers";

export async function POST(req: Request) {
  const { response, followUp } = await receiveIntervalsWebhook(req);
  if (followUp.length > 0) after(() => deliverAll(followUp));
  return response;
}
