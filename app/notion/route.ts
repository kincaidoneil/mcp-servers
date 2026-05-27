import { createNotionMcpHandler } from "./_internal/server";

let cached: ReturnType<typeof createNotionMcpHandler> | null = null;
function handler() {
  if (!cached) cached = createNotionMcpHandler();
  return cached;
}

export function GET(req: Request) {
  return handler()(req);
}
export function POST(req: Request) {
  return handler()(req);
}
export function DELETE(req: Request) {
  return handler()(req);
}
