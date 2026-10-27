package app.starkeep.attestedkey

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * A signing key in the Android Keystore that the cloud can trust to speak for
 * this app.
 *
 * ## Why the cloud needs it
 *
 * The phone signs in through a public Cognito client, so a token says who the
 * user is but not which app holds it. The Keystore can prove the app: a key
 * generated with an attestation challenge comes with a certificate chain that
 * ends at Google's hardware attestation root, and the leaf names this app's
 * package and signing certificates, the device's boot state and the challenge.
 * The Keystore writes those, not the app. The cloud checks the chain once, at
 * registration, and every later request carries a signature by the key.
 *
 * ## The calls
 *
 * - `generate` makes a fresh EC P-256 key under `alias`, replacing any key
 *   already there, with the given challenge, and returns the chain. StrongBox
 *   first, because its keys never leave a separate secure element; the TEE
 *   when the device has no StrongBox.
 * - `signDigest` signs a SHA-256 digest the caller already computed, with
 *   `NONEwithECDSA`. That is the same signature `SHA256withECDSA` makes over
 *   the whole message, and it keeps a megabyte request body out of the bridge
 *   call; the body is hashed natively by expo-crypto before this runs.
 * - `remove` deletes the key, at sign-out.
 *
 * The key never leaves the Keystore, and no call returns private material.
 */
class StarkeepAttestedKeyModule : Module() {
  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  private fun spec(alias: String, challenge: ByteArray, strongBox: Boolean): KeyGenParameterSpec =
    KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      // NONE for the pre-hashed digests `signDigest` signs; SHA-256 so the key
      // stays usable by an ordinary SHA256withECDSA too.
      .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
      .setAttestationChallenge(challenge)
      .setIsStrongBoxBacked(strongBox)
      .build()

  override fun definition() = ModuleDefinition {
    Name("StarkeepAttestedKey")

    AsyncFunction("generate") { alias: String, challengeBase64: String ->
      val challenge = Base64.decode(challengeBase64, Base64.NO_WRAP)
      val store = keyStore()
      if (store.containsAlias(alias)) store.deleteEntry(alias)
      val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
      try {
        generator.initialize(spec(alias, challenge, strongBox = true))
        generator.generateKeyPair()
      } catch (e: StrongBoxUnavailableException) {
        generator.initialize(spec(alias, challenge, strongBox = false))
        generator.generateKeyPair()
      }
      val chain = keyStore().getCertificateChain(alias)
        ?: throw CodedException("ERR_NO_ATTESTATION", "The Keystore returned no attestation chain", null)
      chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
    }

    AsyncFunction("signDigest") { alias: String, digestBase64: String ->
      val key = keyStore().getKey(alias, null) as? PrivateKey
        ?: throw CodedException("ERR_NO_KEY", "No attested key under $alias", null)
      val signature = Signature.getInstance("NONEwithECDSA")
      signature.initSign(key)
      signature.update(Base64.decode(digestBase64, Base64.NO_WRAP))
      Base64.encodeToString(signature.sign(), Base64.NO_WRAP)
    }

    AsyncFunction("remove") { alias: String ->
      val store = keyStore()
      if (store.containsAlias(alias)) store.deleteEntry(alias)
    }
  }

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
  }
}
