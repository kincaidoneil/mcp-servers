// Runtime collaborators that tests swap out: storage, the callback transport,
// and the clock.

import { createSafeCallbackFetch, type CallbackFetch } from "./events/callback";
import { createStore, type Store } from "./events/store";
import { upstashKv } from "./kv";

export interface Deps {
  store: Store;
  callbackFetch: CallbackFetch;
  now: () => number;
}

let cached: Deps | null = null;

export function getDeps(): Deps {
  if (cached) return cached;
  const now = Date.now;
  cached = { store: createStore(upstashKv(), now), callbackFetch: createSafeCallbackFetch(), now };
  return cached;
}

export function setDepsForTesting(deps: Deps | null) {
  cached = deps;
}
