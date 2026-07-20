import { createAsMetadataRoute } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";

const route = createAsMetadataRoute(() => getConfig().oauth, ["mcp:read"]);
export const GET = route.GET;
export const OPTIONS = route.OPTIONS;
