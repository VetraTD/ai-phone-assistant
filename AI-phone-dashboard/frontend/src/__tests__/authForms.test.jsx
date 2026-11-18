import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// ---------------------------------------------------------------------------
// The login and signup FORMS, wired to src/auth.js.
//
// WRITTEN BECAUSE A REAL LOGIN FOUND A BUG NOTHING ELSE COULD. `Login.jsx`
// declares `const signIn = async (e) => {...}` as its submit handler and the
// swap to Identity Platform added `import { signIn } from "./auth"`. The local
// binding SHADOWS the import, so the handler called ITSELF with the submit
// event as the email. Signup had the identical collision.
//
// Nothing caught it: `vite build` succeeded, the root suite was green at 2,189
// tests, the backend at 111, and the frontend at 29. The only symptom was a
// button stuck reading "Signing in...", visible only by pressing it. Both
// imports are aliased now, and this asserts the wiring rather than the alias —
// a test that read the import name would pass on any spelling that still
// recursed.
//
// The auth module is mocked, deliberately: these are tests of the FORMS. What
// src/auth.js does with Identity Platform is verified against the real service,
// and its token verification is forged at every claim in the root's
// tests/idToken.test.js.
// ---------------------------------------------------------------------------

const signIn = vi.fn();
const signUp = vi.fn();
const sendPasswordReset = vi.fn();

vi.mock("../auth", () => ({
  signIn: (...args) => signIn(...args),
  signUp: (...args) => signUp(...args),
  sendPasswordReset: (...args) => sendPasswordReset(...args),
  getAccessToken: vi.fn(),
  signOut: vi.fn(),
  onAuthChange: vi.fn(() => () => {}),
  currentUser: vi.fn(),
  checkPasswordResetCode: vi.fn(),
  completePasswordReset: vi.fn(),
  auth: {},
}));

const { default: Login } = await import("../Login.jsx");
const { default: Signup } = await import("../Signup.jsx");

const wrap = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  signIn.mockReset().mockResolvedValue({});
  signUp.mockReset().mockResolvedValue({});
  sendPasswordReset.mockReset().mockResolvedValue({});
});

describe("Login", () => {
  it("CALLS signIn with the email and password — not itself with the event", async () => {
    const user = userEvent.setup();
    wrap(<Login onSwitchToSignup={() => {}} />);

    await user.type(screen.getByLabelText("Email"), "staff@clinic.test");
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith("staff@clinic.test", "hunter2hunter2");
  });

  it("shows the message the auth layer returns, not a vendor error code", async () => {
    signIn.mockResolvedValue({ error: "That email or password is not right." });
    const user = userEvent.setup();
    wrap(<Login onSwitchToSignup={() => {}} />);

    await user.type(screen.getByLabelText("Email"), "staff@clinic.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("That email or password is not right.")).toBeInTheDocument();
  });

  it("stops showing 'Signing in...' once the attempt finishes", async () => {
    // The exact symptom the shadowing produced: the handler recursed, threw,
    // and `setLoading(false)` never ran. A button that never comes back is what
    // a locked-out receptionist actually sees.
    signIn.mockResolvedValue({ error: "nope" });
    const user = userEvent.setup();
    wrap(<Login onSwitchToSignup={() => {}} />);

    await user.type(screen.getByLabelText("Email"), "staff@clinic.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled());
  });

  it("asks for an email before sending a reset, and does not call out without one", async () => {
    const user = userEvent.setup();
    wrap(<Login onSwitchToSignup={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Forgot password?" }));

    expect(sendPasswordReset).not.toHaveBeenCalled();
    expect(await screen.findByText("Enter your email first.")).toBeInTheDocument();
  });

  it("sends a reset with a continueUrl, and says the same thing either way", async () => {
    const user = userEvent.setup();
    wrap(<Login onSwitchToSignup={() => {}} />);

    await user.type(screen.getByLabelText("Email"), "staff@clinic.test");
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));

    await waitFor(() => expect(sendPasswordReset).toHaveBeenCalledTimes(1));
    expect(sendPasswordReset).toHaveBeenCalledWith(
      "staff@clinic.test",
      expect.objectContaining({ continueUrl: expect.stringContaining("/reset-password") })
    );
    // Deliberately not "we sent you a link" vs "no such account" — the wording
    // must not turn this form into a way to enumerate staff addresses.
    expect(await screen.findByText(/if that email has an account/i)).toBeInTheDocument();
  });
});

describe("Signup", () => {
  it("CALLS signUp with the email and password — not itself with the event", async () => {
    const user = userEvent.setup();
    wrap(<Signup onSwitchToLogin={() => {}} />);

    await user.type(screen.getByLabelText("Email"), "new@clinic.test");
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signUp).toHaveBeenCalledTimes(1));
    expect(signUp).toHaveBeenCalledWith("new@clinic.test", "hunter2hunter2");
  });

  it("shows the auth layer's message on failure", async () => {
    signUp.mockResolvedValue({ error: "An account already exists for that email." });
    const user = userEvent.setup();
    wrap(<Signup onSwitchToLogin={() => {}} />);

    await user.type(screen.getByLabelText("Email"), "taken@clinic.test");
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("An account already exists for that email.")).toBeInTheDocument();
  });
});
