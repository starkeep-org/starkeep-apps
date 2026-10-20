/**
 * What connects this phone to a cloud, as the screens show it.
 *
 * - `session`: the person signed in with their Starkeep account, the only way
 *   a phone connects.
 */
export type CloudConnection = { readonly kind: "session"; readonly baseUrl: string; readonly email: string | null };

/** A cloud's address, as a person reads it: the host alone. */
export function hostLabel(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
}
