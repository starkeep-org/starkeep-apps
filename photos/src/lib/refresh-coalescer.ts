/**
 * Serialize refresh requests and retain one trailing refresh.
 *
 * A rendition publishes through several writes, and each write emits an SSE
 * kick. When a tile is awaiting a child rendition, every kick requires a full
 * library re-list because the parent's incremental cursor does not move when a
 * child is created. Letting those re-lists overlap amplifies one derivation
 * into a burst of identical queries and permits older responses to land after
 * newer ones.
 */
export function createRefreshCoalescer(refresh: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | null = null;
  let trailing = false;

  return function requestRefresh(): Promise<void> {
    if (active) {
      trailing = true;
      return active;
    }

    active = (async () => {
      do {
        trailing = false;
        await refresh();
      } while (trailing);
    })().finally(() => {
      active = null;
    });
    return active;
  };
}
