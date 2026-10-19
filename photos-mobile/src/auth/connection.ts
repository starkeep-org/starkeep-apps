/**
 * What connects this phone to a cloud, as the screens show it.
 *
 * - `session`: the person signed in with their Starkeep account, the only way
 *   a phone connects.
 */
export type CloudConnection = { readonly kind: "session"; readonly baseUrl: string; readonly email: string | null };
