// Browser-storage cache of the session, so a remount of the iframe (every
// re-render of the conversation) comes back where the user left off. Storage
// can be unavailable inside a sandbox, so every access is guarded; the model's
// context updates are the fallback, via pare-start's `decisions`.

import { SessionSchema, type Session } from "../../schema";

const PREFIX = "pare:session:";

export function loadCached(sessionId: string): Session | null {
  try {
    const raw = localStorage.getItem(PREFIX + sessionId);
    if (!raw) return null;
    const parsed = SessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveCached(session: Session): boolean {
  try {
    localStorage.setItem(PREFIX + session.id, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

// Fresh tool input wins on config; the cache wins on decisions it made after
// the input's seed. A seed decision the cache does not have is kept, unless
// the cache says the user took that decision back.
export function mergeCached(fresh: Session, cached: Session | null): Session {
  if (!cached) return fresh;
  const itemIds = new Set(fresh.config.items.map((item) => item.id));
  const cleared = new Set(cached.cleared);
  const decisions = { ...fresh.decisions };
  for (const id of cleared) delete decisions[id];
  for (const [id, decision] of Object.entries(cached.decisions)) {
    if (!itemIds.has(id)) continue;
    const seed = decisions[id];
    if (!seed || (decision.decided_at ?? "") >= (seed.decided_at ?? "")) decisions[id] = decision;
  }
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const id of [...cached.queue, ...fresh.queue]) {
    if (itemIds.has(id) && !decisions[id] && !seen.has(id)) {
      seen.add(id);
      queue.push(id);
    }
  }
  return {
    ...fresh,
    decisions,
    queue,
    cleared: [...cleared].filter((id) => itemIds.has(id) && !decisions[id]),
    // A finished pass stays finished unless the input brought new items.
    status:
      cached.status === "done" && queue.every((id) => cached.queue.includes(id)) ? "done" : "open",
    sent: cached.sent,
    updated_at: cached.updated_at > fresh.updated_at ? cached.updated_at : fresh.updated_at,
  };
}
