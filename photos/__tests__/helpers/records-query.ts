/**
 * The half of the data server a fake `/data/records` must not get wrong.
 *
 * A stub that answers every query shape certifies queries the real servers
 * refuse. That is not hypothetical: `{"id":{"eq":…}}` reads like a filter,
 * passed every test written against a permissive fake, and was a 400 on both
 * servers — the grammar spells equality as a bare scalar and reserves objects
 * for the operators below. The cloud resize Lambda 500'd on every request until
 * a tier-3 run against real AWS found it.
 *
 * So a fake in these tests checks the grammar before it answers. The list is
 * the platform's, from `@starkeep/shared-space-api`'s query parser; Photos does
 * not depend on that package, so this mirrors it and says where it came from.
 */
const OPERATORS = ["lt", "lte", "gt", "gte", "ne", "in", "is", "prefix", "like"];

/** Throws the way both servers answer 400, so a bad query fails its own test. */
export function assertRecordsQuery(path: string): void {
  const query = new URL(path, "http://data-server.test").searchParams;
  const where = query.get("where");
  if (where === null) return;
  const parsed = JSON.parse(where) as Record<string, unknown>;
  for (const [column, predicate] of Object.entries(parsed)) {
    // A scalar means equality; only an object names an operator.
    if (predicate === null || typeof predicate !== "object") continue;
    for (const op of Object.keys(predicate as Record<string, unknown>)) {
      if (!OPERATORS.includes(op)) {
        throw new Error(
          `"${op}" is not an operator; supported operators are ${OPERATORS.join(", ")} ` +
            `(where[${column}])`,
        );
      }
    }
  }
}
