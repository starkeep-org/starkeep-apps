/**
 * What connects this phone to a cloud, as the screens show it.
 *
 * - `session`: the person signed in with their Starkeep account.
 * - `paired`: a key an admin approved, from before sign-in existed. Kept so a
 *   paired phone syncs until its owner signs in; it goes once pairing is
 *   retired.
 */
export type CloudConnection =
  | { readonly kind: "session"; readonly baseUrl: string; readonly email: string | null }
  | { readonly kind: "paired"; readonly baseUrl: string; readonly deviceId: string; readonly label: string | null };
