"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";

interface SweepStatus {
  sweep: {
    running: boolean;
    stage: "cheap" | "full";
    examined: number;
    derived: number;
    failed: number;
    undecodable: number;
  };
  undecodableHere: { count: number };
}

const POLL_INTERVAL_MS = 3_000;

/**
 * "Still deriving", said out loud.
 *
 * The condition this makes legible is otherwise invisible and reads as a bug: a
 * library whose renditions have not been made yet is a grid of placeholders,
 * and nothing on screen distinguishes that from a broken app. It is also the
 * one thing about the new arrangement that a user has to understand — nothing
 * derives while Photos is not running, because the sweep is a thread inside
 * this server — and a status line is the cheapest place to say it.
 *
 * Polled rather than streamed. It is one small local read, the sweep changes
 * state on the order of seconds, and a second event stream beside the data
 * plane's would be more moving parts than a number in a header is worth.
 *
 * Renders nothing when there is nothing to say, which is most of the time.
 */
export function DerivationStatus() {
  const [status, setStatus] = useState<SweepStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch(withBasePath("/api/derive/status"));
        // 501 is the cloud answer — derivation there is on demand for what is
        // on screen, and there is no sweep to report on.
        if (!cancelled) setStatus(res.ok ? ((await res.json()) as SweepStatus) : null);
      } catch {
        if (!cancelled) setStatus(null);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!status) return null;
  const { sweep, undecodableHere } = status;
  if (!sweep.running && undecodableHere.count === 0) return null;

  return (
    <span style={{ fontSize: 12, color: "#999", whiteSpace: "nowrap" }}>
      {sweep.running
        ? sweep.stage === "cheap"
          ? `Preparing photos… ${sweep.derived} done`
          : `Making larger sizes… ${sweep.derived} done`
        : null}
      {!sweep.running && undecodableHere.count > 0
        ? `${undecodableHere.count} photo${undecodableHere.count === 1 ? "" : "s"} this machine cannot read`
        : null}
    </span>
  );
}
