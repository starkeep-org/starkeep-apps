/**
 * Bringing the node up, and keeping the screen's view of it fresh.
 *
 * Two hooks, split because they fail differently. The node comes up once and
 * either works or does not; the library is queried repeatedly and every query
 * can be stale. Folding them together would make a failed import look like a
 * failed node.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createHLCClock, type HLCClock } from "@starkeep/protocol-primitives";
import { listLibrary, summarizeLibrary, type LibraryItem, type LibrarySummary } from "../library";
import { importDeviceMedia, type ImportOutcome, type ImportProgress } from "../media/import";
import type { NodeIdentity } from "../node-identity";
import type { MobileNode } from "../node";
import { bringUpNode, clearNodeData, importDepsFor } from "../platform";

/** How many tiles the grid shows. A ceiling, not a page size — see `MediaGrid`. */
export const LIBRARY_PAGE = 60;

/** How many assets one import pass considers. */
export const IMPORT_BATCH = 60;

export type NodeState =
  | { readonly status: "starting" }
  | {
      readonly status: "ready";
      readonly node: MobileNode;
      readonly identity: NodeIdentity;
      readonly clock: HLCClock;
    }
  | { readonly status: "failed"; readonly error: string };

/**
 * Open this device's node, once.
 *
 * Failure is a state rather than a throw. The database or the object store can
 * genuinely fail to open — a full disk, a corrupt file — and a screen that
 * says so is worth more than a red box, because the thing that failed is the
 * thing the user would otherwise be told is empty.
 */
export interface NodeHandle {
  readonly state: NodeState;
  /**
   * Delete everything this node has indexed and open a fresh one.
   *
   * Resolves once the replacement is up, so a caller can reload immediately
   * afterwards without racing the node it is about to query.
   */
  reset: () => Promise<void>;
}

export function useNode(): NodeHandle {
  const [state, setState] = useState<NodeState>({ status: "starting" });
  /** Bumped to force the effect to build a new node after a reset. */
  const [generation, setGeneration] = useState(0);
  const current = useRef<MobileNode | null>(null);
  /** Resolved by the effect once the post-reset node is up. */
  const opening = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: MobileNode | null = null;

    void bringUpNode()
      .then(({ node, identity }) => {
        opened = node;
        if (cancelled) {
          // Brought up after the screen went away — close it rather than leak
          // an open database handle for the rest of the process's life.
          void node.close();
          return;
        }
        current.current = node;
        setState({
          status: "ready",
          node,
          identity,
          clock: createHLCClock({ nodeId: identity.nodeId }),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "failed", error: String(err) });
      })
      .finally(() => {
        opening.current?.();
        opening.current = null;
      });

    return () => {
      cancelled = true;
      // Only if this is still the live node. A reset closes the old one itself
      // — it has to, before deleting the file out from under SQLite — and then
      // bumps `generation`, which runs this cleanup for a node that is already
      // shut. Closing twice is not free: the second `close()` runs against a
      // handle that no longer has a database behind it.
      if (opened && current.current === opened) {
        current.current = null;
        void opened.close();
      }
    };
  }, [generation]);

  const reset = useCallback(async () => {
    const node = current.current;
    if (!node) return;
    current.current = null;
    setState({ status: "starting" });
    await clearNodeData(node);

    // Wait for the effect's replacement rather than building one here: two code
    // paths creating nodes is two code paths that can disagree about how, and
    // the effect already owns the lifecycle including cleanup.
    const built = new Promise<void>((resolve) => {
      opening.current = resolve;
    });
    setGeneration((n) => n + 1);
    await built;
  }, []);

  return { state, reset };
}

export interface LibraryState {
  readonly items: readonly LibraryItem[];
  readonly summary: LibrarySummary | null;
  readonly loading: boolean;
  readonly importing: boolean;
  readonly lastImport: ImportOutcome | null;
  /** Non-null only while an import is running. */
  readonly progress: ImportProgress | null;
  readonly error: string | null;
  reload: () => Promise<void>;
  importNow: () => Promise<void>;
}

/** The node's records, and the action that adds the camera roll to them. */
export function useLibrary(node: NodeState): LibraryState {
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lastImport, setLastImport] = useState<ImportOutcome | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = node.status === "ready" ? node : null;

  const reload = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      const deps = { database: ready.node.databaseAdapter, aliases: ready.node.mediaAliases };
      const [page, totals] = await Promise.all([
        listLibrary(deps, { limit: LIBRARY_PAGE }),
        summarizeLibrary(deps),
      ]);
      setItems(page.items);
      setSummary(totals);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [ready]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const importNow = useCallback(async () => {
    if (!ready) return;
    setImporting(true);
    try {
      const deps = importDepsFor(ready.node, ready.clock);

      // Permission is requested here rather than on mount, because this is the
      // point at which the user has asked for something that needs it. A system
      // dialog thrown at someone before they have done anything has asked for
      // something before saying what for.
      const permission = await deps.media.requestPermissions();
      if (!permission.granted) {
        setError("Starkeep needs access to your photos to add them to this device's library.");
        return;
      }

      setLastImport(
        await importDeviceMedia(
          {
            ...deps,
            onProgress: (p) => {
              setProgress(p);
              // Also to logcat, because the on-screen line is a summary and the
              // per-asset split between "pulling bytes across JSI" and "hashing
              // them in JavaScript" is what says which one to go and fix.
              console.log(
                `[starkeep:import] ${p.done}/${p.total} ${p.filename ?? "?"} ` +
                  `${p.sizeBytes}B read=${p.readMs}ms hash=${p.hashMs}ms`,
              );
            },
          },
          { limit: IMPORT_BATCH },
        ),
      );
      setProgress(null);
      setError(null);
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  }, [ready, reload]);

  return { items, summary, loading, importing, lastImport, progress, error, reload, importNow };
}
