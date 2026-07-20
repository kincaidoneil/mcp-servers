import { createHevyMcpHandler } from "./_internal/server";

let cached: ReturnType<typeof createHevyMcpHandler> | null = null;
function handler() {
  if (!cached) cached = createHevyMcpHandler();
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
