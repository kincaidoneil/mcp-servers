import { createProtectedResourceRoute } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";

const route = createProtectedResourceRoute(() => getConfig().oauth);
export const GET = route.GET;
export const OPTIONS = route.OPTIONS;
