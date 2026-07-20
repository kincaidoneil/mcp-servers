import { z } from "zod";
import type { HevyClient } from "../client";
import { BodyMeasurementWriteSchema, PageSchema, PageSize10Schema } from "../schemas";

export const ListBodyMeasurementsInputSchema = z.object({
  page: PageSchema,
  pageSize: PageSize10Schema,
});

export function listBodyMeasurements(
  input: z.infer<typeof ListBodyMeasurementsInputSchema>,
  client: HevyClient,
) {
  return client.listBodyMeasurements(input);
}

export const LogBodyMeasurementInputSchema = BodyMeasurementWriteSchema;

export function logBodyMeasurement(
  input: z.infer<typeof LogBodyMeasurementInputSchema>,
  client: HevyClient,
) {
  return client.createBodyMeasurement(input);
}
