/** Temporary measurement instrumentation. Remove before shipping. */
export function perf(label: string): void {
  console.log(`[perf] ${label} ${Date.now()}`);
}
