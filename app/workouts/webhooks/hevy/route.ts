import { after } from "next/server";
import { deliverAll } from "../../_internal/events/dispatch";
import { receiveHevyWebhook } from "../../_internal/receivers";

export async function POST(req: Request) {
  const { response, followUp } = await receiveHevyWebhook(req);
  if (followUp.length > 0) after(() => deliverAll(followUp));
  return response;
}
