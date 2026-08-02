# How the phone syncs — design for todo #51

Companion to `import-loop-design.md` §5.2, which named the problem and sketched three options.
This is the concrete design. Nothing here is implemented.

**Status: awaiting confirmation on §4 (how a device gets registered).** Everything else follows.

---

## 1. What is true today, verified

- **HMAC is the only authentication on the cloud data plane.** `api-handler.ts:1558` gates every
  `/apps/{appId}/*` route on a signature checked against a per-app SSM SecureString. There is no
  JWT authorizer; `data-roles-and-permissions.md` describes one in the present tense and is wrong.
- **No user identity reaches the data plane at any point.** The deployment is single-tenant by
  construction: it is the operator's own AWS account.
- **The signature covers `${appId}:${METHOD}:${path}:${ts}:` ++ body bytes**, hex HMAC-SHA256, with
  a 5-minute skew window (`app-client/src/sign.ts`). The verifier re-derives it by hand because the
  Lambda cannot import that package.
- **The phone needs two channels.** Shared records — the photographs — go through Drive
  (`sync-supervisor.ts:247` builds `/apps/starkeep-drive/...`). App-specific rows (captions) go
  through the `photos` channel. They are separate engines against separate base URLs.
- **`createHttpSyncTransport` already takes a `signRequest` hook** and is exported from
  `@starkeep/sync-engine`, so the phone needs no new transport.
- **`HttpObjectStorageAdapter` is not publishable.** It lives in `apps/local-data-server/`, so
  nothing outside core's workspace can import it. See §6 — this is the one hard prerequisite.

## 2. The shape of the answer

**A per-device keypair. The phone signs with a private key only it holds; the cloud verifies against
a registered public key.**

The alternative that keeps coming up is "give the handset the app's HMAC secret", and it must not be
taken. The secret is symmetric, so a handset holding it *is* the app; it is extractable, since an
APK is distributable and a rooted device reads what the app reads; it never expires; and revoking it
after a lost phone breaks the laptop and the app's cloud Lambda too. It is the shortcut whose cost
lands entirely in the future.

### 2.1 Where the public keys live: SSM, not the database

This is the finding that most changed the design. The obvious home for a device registry is a table
— but **the verifier cannot read one**. Verification happens *before* any app role is assumed, and
the cloud-data-server's own credentials deliberately have no access to shared data
(`data-roles-and-permissions.md`: "its own credentials never read or write shared data"). A device
registry in `shared.*` would be unreadable by the code that needs it.

The per-app HMAC secret has exactly this problem already, and it is solved: it lives in SSM, readable
by the Lambda role, cached for five minutes. Device public keys take the same path —
`/${stackPrefix}/device-keys/<deviceId>` — and inherit the cache, the failure modes and the
revocation story for free. No DDL, no schema, no role change, no DSQL round trip on the auth path.

Public keys are not secret, so the parameter need not be a SecureString; making it one anyway costs
nothing and keeps one convention.

### 2.2 The signature

New headers alongside the existing ones:

```
X-Starkeep-App-Id      unchanged — which channel (starkeep-drive | photos)
X-Starkeep-Device-Id   which device is asking
X-Starkeep-Device-Sig  Ed25519 over the same canonical message
X-Starkeep-App-Ts      unchanged — the skew window is unchanged
```

**The signed message is byte-identical to the HMAC one** — `${appId}:${METHOD}:${path}:${ts}:` ++
body — so the method/path/timestamp binding, the replay window and the canonical-path handling are
inherited rather than re-derived. Only the primitive changes. A second canonicalisation is how two
implementations come to disagree about what was signed.

The verifier's gate becomes: *device headers present* → resolve the device key from SSM and verify
Ed25519; *otherwise* → today's HMAC path, untouched. Server-to-server callers are unaffected.

Ed25519 via `@noble/curves` — pure JS, small, works on Hermes, and signs a 32-byte digest in under a
millisecond. Node's `crypto` verifies it natively in the Lambda. Signing cost is irrelevant here
because the message is hashed first; this is not the import loop.

### 2.3 Where the private key lives

`expo-secure-store`, which is Keystore-encrypted at rest. **Not** hardware-backed non-extractable —
that needs a native module doing Keystore-generated EC keys, and it is a strict upgrade that can
land later without changing anything above. What this already buys, and what matters most, is that
the credential is **per-device and individually revocable**: a lost phone is one deleted SSM
parameter, and nothing else in the system notices.

## 3. What a device is allowed to do

A registered device may sign for **any installed app**. Stated rather than assumed, because it is the
weakest claim here.

The justification is that the device *is* the user's, running the user's app, against the user's
single-tenant cloud — and that this app legitimately needs two channels already (`starkeep-drive`
for photographs, `photos` for captions), so a per-app device key would mean two registrations for
one pairing and a third the day a second app ships.

What it gives up is the property that every action is attributable to one app's authority. Origin
attribution survives — `origin_app_id` is on the record — but the *authorisation* becomes
per-device rather than per-app. On a handset, where our app is the only thing holding the key, that
distinction has no teeth today. It would need revisiting if a second Starkeep app ever shares a
device, which the Android plan already flags as a shared-container problem.

## 4. How a device gets registered — **the open question**

Registration is the one step that cannot be authenticated by the thing being registered. Two ways,
and they differ in what "authorised" means rather than in mechanism.

### R1 — the phone registers itself, using its Cognito session

`POST /devices/register` with the user's Cognito access token; the Lambda verifies it against the
pool's JWKS and writes the public key to SSM.

- Makes sign-in *mean* something on the handset, which is what its UI already implies.
- Self-service: no laptop involved, works for a device that is nowhere near the operator.
- **Cost:** a JWT verifier in the Lambda — JWKS fetch, caching, RS256 verification, issuer/audience
  checks. This is the first place user identity would enter the data plane at all, which is a
  meaningful architectural change to make on the way to something else.

### R2 — the operator approves the device from admin-web

The phone shows its device id and public key (or a short pairing code); the operator approves it in
admin-web, which already holds privileged credentials and can write SSM through the manager role.

- **No change to the data plane's auth model at all.** No JWT verifier, no new Lambda dependency, no
  user identity anywhere. The privileged console does the privileged thing, which is what it is for.
- Pairing requires possession of the admin console — a stronger bar than a password.
- **Cost:** a manual step per device, and it makes the phone's Cognito sign-in *unnecessary for
  sync*, which contradicts what the app currently tells the user sign-in buys.

### 4.1 Investigated: does R1 buy multi-user? — **No, and that is the finding**

R1 was investigated properly on the strength of "multiple users signing in to one Starkeep instance
is a goal". Six things were checked. The conclusion is that R1 does not move the system toward
multi-user, and would misrepresent how far along it is.

**The data plane is app-identified by deliberate decision, not by omission.** The route definitions
say so in as many words (`cloud-data-server-program.ts`, on `/apps/{appId}/*`):

> App identity is established by the handler's HMAC verifier … not by the gateway's JWT authorizer.
> **The data plane identifies the *app*, not the end user; end-user identity is the app's business.**

So R1 is not "adding the missing piece". It is reversing a stated position, and that is a decision
to take on its own merits rather than as a means to getting a phone syncing.

**A Cognito JWT authorizer already exists** (`cognito-jwt`, audience = the pool client, issuer = the
pool) and is wired to app *compute* routes via `isPublic ? {} : { authorizerId, authorizationType }`.
The data-plane routes deliberately opt out. So R1's infrastructure cost is near zero — this was
overstated in §4 above. Verification could even be done in-Lambda in ~40 lines with no new
dependency, since Node 22 imports JWKs natively. **R1 is cheap. It is just not sufficient.**

**Nothing downstream can represent a second user.** This is the real blocker, and it is everywhere:

| Layer | State |
|---|---|
| `shared.records` | No owner column — `id, type, timestamps, node_id, hashes, origin_app_id, parent_id` |
| `shared.record_labels` | Same; scoped by `app_id`, never by user |
| Object keys | `shared/<category>/<shard>/<sha256>` — content-addressed, **globally shared** |
| PG roles | `user_data_owner` — singular, `GRANT ALL … ON SCHEMA shared` |
| Drive channel | One app id, one HMAC secret, one `shared/*` IAM ceiling |
| Row-level security | DSQL has none; per-*type* filtering is already application-layer |

The content-addressed keys deserve their own note, because the problem there is not just a missing
column. Two users with the same photograph get the **same object key**. That is free deduplication
and three liabilities: an existence oracle (probing a hash reveals whether *anyone* holds that
file), a deletion hazard (whoever GCs it takes it from the other), and an IAM ceiling that cannot
separate users because the prefix has no user in it. Fixing that means per-user key prefixes —
giving up cross-user dedup, which is the right trade for a personal-data system but is a real
change to §4.4 of the media plan.

**What Cognito already supports:** the pool is `AllowAdminCreateUserOnly: true`, so multiple users
are creatable today; there is simply nothing for a second one to own.

**Conclusion.** Multi-user is a data-partitioning project spanning six layers, not an authentication
feature. R1 would authenticate a user and then hand them the same single shared dataset — the system
would *look* multi-user while every user read every other user's library. That is worse than not
having it, because it implies the hard part is done.

### 4.2 The way out: separate the user binding from the auth mechanism

The reason R1 was tempting is real and worth keeping: **if devices are registered without a user
now, every device needs a migration when partitioning lands.**

But the user binding does not require JWT verification. Under R2, admin-web is doing the pairing,
and admin-web can list the Cognito pool's users — so it knows perfectly well which user it is
pairing a device *for*. It writes `{ publicKey, userId }` and the verifier carries `userId` forward
from the moment there is anything to carry it to.

**So R2 gets multi-user readiness without the JWT verifier and without contradicting the documented
stance.** The device→user mapping exists from day one; what does not yet exist is anything that
reads it, which is exactly the honest state.

**Recommendation: R2, recording `userId` on every device registration.** R1 becomes the right answer
the day devices must enrol without the operator present, and it is additive then rather than a
rewrite, because everything in §2 is unchanged either way.

The consequence to accept is that **sign-in and sync become independent**, and the home screen has
to stop implying otherwise.

### 4.3 Proof the mechanism works

A PoC (`scratchpad/device-sig-poc.mjs`) exercises the §2.2 scheme against the real canonical message.
10/10:

- a device-signed request verifies, and **carries `userId`** through to the handler
- the app HMAC path still verifies, untouched
- path, appId and body bindings all hold — a captured signature replays nowhere
- a revoked device is rejected, and revoking it disturbs no app secret
- two devices with different users verify independently
- one device cannot sign as another

Costs measured: signing a 1 MB body is **1.68 ms** (Ed25519 hashes internally, so body size barely
matters), and a public key is **60 characters** as stored — well inside an SSM parameter.

## 5. What the phone does once it can authenticate

`bringUpNode` currently passes no `cloud`, so `engine` is null and `exchange()` is a no-op — which
is why signing in changed nothing visible. With a device key:

```
cloud: {
  transport:           createHttpSyncTransport({ baseUrl: `${cloudUrl}/apps/starkeep-drive`, signRequest }),
  remoteObjectStorage: new HttpObjectStorageAdapter({ baseUrl: `${...}/files`, signRequest }),
}
```

**Drive first, and only Drive.** It carries the shared records, which is what makes photographs
appear on other devices. Captions ride the `photos` channel and are a second engine; they are not
needed to answer "did my photos sync" and they drag in the `photos-lib` split (§5.1 of the import
design). One channel working end to end beats two half-wired.

Triggering: a **"Sync now" button** first, because `exchange()` must be observed before it is
scheduled, and the job graph's `sync-metadata`/`push-blobs` bindings are item 14 and need
WorkManager. Manual first is not a shortcut here — a background sync that silently does nothing is
the failure mode this whole session has been about.

## 6. The hard prerequisite, and it spans both repos

**`HttpObjectStorageAdapter` must move into a published package.** It is the phone's
`remoteObjectStorage`, without which metadata syncs and every blob transfer fails. It currently
lives in `apps/local-data-server/` where nothing outside core's workspace can reach it.

It should **move**, not be copied: a second implementation of "how this node talks to remote object
storage" is the same mistake `src/node.ts` refuses to make about the sync engine. `@starkeep/sync-engine`
is the natural home, next to `createHttpSyncTransport`, which it mirrors.

That means: core change → publish → bump `starkeep-apps`. Worth knowing before starting, because
`project_apps_stale_published_core_pkgs` records that this seam has bitten before — the apps repo
resolves published packages, and a core API change that has not been published yet surfaces as a
missing-export build failure.

## 7. Order of work

1. Move `HttpObjectStorageAdapter` into `@starkeep/sync-engine`. Publish. (core)
2. Device keypair on the phone: generate, store in `expo-secure-store`, expose the public key.
3. Registration path — R1 or R2 per §4. (cloud + admin-web)
4. Cloud verifier: device headers → SSM public key → Ed25519, HMAC path untouched. (core)
5. Phone: build the node with a Drive `cloud`, add "Sync now", observe one exchange.
6. Then, separately: the `photos` channel for captions, and the job-graph bindings.

Steps 1 and 2 are independent of the §4 decision and can start immediately.

## 8. What this does not solve

- **Captions still need the `photos` channel and the `photos-lib` split.** Interop cannot be
  demonstrated until both exist.
- **The key is not hardware-backed.** `expo-secure-store` is Keystore-*encrypted*, not
  Keystore-*generated*. A rooted device can extract it. Per-device revocation is what makes that
  tolerable rather than fine.
- **Nothing here bounds what a device may sync.** Residency and retention are the phone's own
  policy; a compromised device key grants a peer's access to the user's own data, which is the same
  authority the app already has locally.
