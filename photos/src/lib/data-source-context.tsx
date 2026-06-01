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
 * The data-plane URL is a separate concern — see data-client.ts, which
 * decides at boot from runtime config (localDataServerUrl vs apiGatewayUrl)
 * which data server to talk to. The hook and the client modules don't see
 * both URLs; they pick one and stick with it.
 */
export const FORCE_REMOTE = process.env.NEXT_PUBLIC_FORCE_REMOTE === "true";
