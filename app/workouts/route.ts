import { createWorkoutsMcpHandler } from "./_internal/server";

let cached: ReturnType<typeof createWorkoutsMcpHandler> | null = null;
function handler() {
  if (!cached) cached = createWorkoutsMcpHandler();
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
