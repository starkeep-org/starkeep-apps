import { signInAddress } from "@starkeep/app-client/session-cookies";

interface SignInFormProps {
  /** Where the browser returns once signed in. Must lie under the app's mount. */
  returnPath: string;
}

/**
 * The sign-in control: one button to the platform's sign-in page.
 *
 * Photos never sees a password. The button goes to the platform's
 * `/auth/start`, which sends the browser to Cognito's managed login page; the
 * page takes the password, handles a first sign-in's new password and
 * "Forgot password", and the platform's `/auth/callback` sets Photos' session
 * cookies and returns the browser to `returnPath`.
 *
 * `/auth/start` lives at the origin root, outside Photos' mount, so the
 * address deliberately does not go through `withBasePath`.
 */
export function SignInForm({ returnPath }: SignInFormProps) {
  return (
    <button
      type="button"
      onClick={() => window.location.assign(signInAddress("photos", returnPath))}
      style={btnStyle}
    >
      Sign in
    </button>
  );
}

const btnStyle: React.CSSProperties = {
  background: "rgba(80,140,255,0.15)",
  border: "1px solid rgba(80,140,255,0.4)",
  color: "#ccc",
  borderRadius: 4,
  padding: "7px 14px",
  cursor: "pointer",
  fontSize: 13,
};
