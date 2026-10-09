import { createRegisterRoute } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";

const route = createRegisterRoute(() => getConfig().oauth);
export const POST = route.POST;
export const OPTIONS = route.OPTIONS;
