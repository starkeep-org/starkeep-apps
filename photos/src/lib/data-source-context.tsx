/**
 * Build-time deployment-context flag.
 *
 * NEXT_PUBLIC_FORCE_REMOTE is set to "true" by the cloud bundler (see
 * infra/build-bundle.ts); it controls UI / auth-gate concerns that depend
 * on *where this build runs*, not on which data server it talks to:
 *
 *   - AuthGate requires sign-in only when FORCE_REMOTE.
 *   - The toolbar shows the cloud-setup button and "Remote Sharp" thumbnail
 *     strategy only when FORCE_REMOTE.
 *
 * The data-plane URL is a separate concern — see data-client.ts. The browser
 * always talks to the same-origin /api/local-data proxy; that proxy decides
 * server-side (local creds file vs. cloud SSM) which data server to sign for.
 */
export const FORCE_REMOTE = process.env.NEXT_PUBLIC_FORCE_REMOTE === "true";
