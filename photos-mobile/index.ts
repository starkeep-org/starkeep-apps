/**
 * Give Hermes a `crypto.getRandomValues` before anything else runs.
 *
 * Hermes ships no Web Crypto. `@starkeep/protocol-primitives` calls ulidx's
 * `monotonicFactory()` at module scope, and that probes for a PRNG *eagerly* —
 * so on a handset the import itself throws "Failed to find a reliable PRNG"
 * and the app dies before React mounts, with no JS error handler installed yet
 * to say anything more useful than a red screen full of bundle offsets.
 *
 * This import must stay first, and must stay a bare side-effect import: it
 * installs the global, and ES module evaluation order is the only thing
 * guaranteeing it wins the race against the `./App` import below.
 */
import "react-native-get-random-values";

import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
