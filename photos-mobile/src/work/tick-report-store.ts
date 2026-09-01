/**
 * Where a background tick leaves its report for a foreground launch to find.
 *
 * The process that produces a report is usually gone by the time anyone looks,
 * so the report has to outlive it. One file, overwritten each run, holding the
 * most recent result — there is no history here because the question is what
 * the phone did last, and a growing log on a device nobody can `tail` is a file
 * that only ever grows.
 */

import type { ExpoFileSystem } from "../storage/expo-object-storage";
import type { TickReport } from "./tick";

export interface TickReportStore {
  write(report: TickReport): void;
  read(): Promise<TickReport | null>;
}

export function createTickReportStore(
  fs: ExpoFileSystem,
  path: string,
  directory: string,
): TickReportStore {
  return {
    write(report: TickReport): void {
      // The directory may not exist on a device whose node has never opened —
      // a headless launch can genuinely be the first thing that ever ran.
      fs.directory(directory).create({ intermediates: true, idempotent: true });
      const file = fs.file(path);
      if (!file.exists) file.create({ intermediates: true, overwrite: true });
      file.write(JSON.stringify(report));
    },
    async read(): Promise<TickReport | null> {
      try {
        const file = fs.file(path);
        if (!file.exists) return null;
        return JSON.parse(await file.text()) as TickReport;
      } catch {
        // A half-written or hand-edited file is a missing report rather than a
        // crash on launch. The next run overwrites it.
        return null;
      }
    },
  };
}
