import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const authState = vi.hoisted(() => ({ user: null }));

vi.mock("../../auth", () => ({
  onAuthChange(cb) {
    cb(authState.user);
    return () => {};
  },
  signOut: vi.fn(),
}));
vi.mock("../../Login", () => ({ default: () => <div>login screen</div> }));
vi.mock("../../Onboarding", () => ({ default: () => <div>onboarding screen</div> }));
vi.mock("../../api", () => ({ api: { get: vi.fn(), put: vi.fn() } }));

import { api } from "../../api";
import SessionGate from "../SessionGate";
import { useBusiness } from "../BusinessContext";

function BusinessName() {
  const { business, definitions, capabilityRows } = useBusiness();
  return (
    <div>
      <p>{business.name}</p>
      <p>{definitions ? "definitions loaded" : "no definitions"}</p>
      <p>{`${capabilityRows.length} capability rows`}</p>
    </div>
  );
}

const BRIGHTWORK = { id: "b1", name: "Brightwork Family Dental", phone_number: "+15550100" };

function routeGets(me) {
  api.get.mockImplementation((url) => {
    if (url === "/api/me") return me();
    if (url === "/api/capabilities/definitions") return Promise.resolve({ data: { capabilities: [], adapters: {} } });
    if (url === "/api/business/b1/capabilities") return Promise.resolve({ data: { capabilities: [{ capability_id: "appointments", enabled: true }] } });
    return Promise.reject(new Error("unexpected " + url));
  });
}

describe("SessionGate", () => {
  beforeEach(() => {
    authState.user = { uid: "u1", email: "owner@brightwork.example" };
    api.get.mockReset();
  });

  it("signed out shows the sign-in screen", async () => {
    authState.user = null;
    render(<SessionGate><BusinessName /></SessionGate>);
    expect(await screen.findByText("login screen")).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("a business without a phone number goes to onboarding", async () => {
    routeGets(() => Promise.resolve({ data: { business: { id: "b1", name: "Brightwork Family Dental" } } }));
    render(<SessionGate><BusinessName /></SessionGate>);
    expect(await screen.findByText("onboarding screen")).toBeInTheDocument();
  });

  it("a signed-in, set-up business reaches the children with its business and actions loaded", async () => {
    routeGets(() => Promise.resolve({ data: { business: BRIGHTWORK } }));
    render(<SessionGate><BusinessName /></SessionGate>);
    expect(await screen.findByText("Brightwork Family Dental")).toBeInTheDocument();
    expect(await screen.findByText("definitions loaded")).toBeInTheDocument();
    expect(await screen.findByText("1 capability rows")).toBeInTheDocument();
  });

  it("a failed account load says what to do and Try again asks again", async () => {
    let calls = 0;
    routeGets(() => (++calls === 1 ? Promise.reject(new Error("Network Error")) : Promise.resolve({ data: { business: BRIGHTWORK } })));
    render(<SessionGate><BusinessName /></SessionGate>);
    expect(
      await screen.findByText("We couldn't load your account. Check your connection, then refresh the page.")
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Brightwork Family Dental")).toBeInTheDocument();
    expect(api.get.mock.calls.filter(([u]) => u === "/api/me")).toHaveLength(2);
  });
});
