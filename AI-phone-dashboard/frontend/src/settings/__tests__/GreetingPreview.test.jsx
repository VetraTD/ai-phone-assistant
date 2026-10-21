import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../api", () => ({ api: { get: vi.fn() } }));

import { api } from "../../api";
import GreetingPreviewButton from "../GreetingPreviewButton";
import AIBehaviorSection from "../AIBehaviorSection";

const BID = "22222222-2222-2222-2222-222222222222";

let audios;
beforeEach(() => {
  audios = [];
  api.get.mockReset();
  globalThis.Audio = class {
    constructor(url) {
      this.url = url;
      this.play = vi.fn().mockResolvedValue(undefined);
      this.pause = vi.fn();
      audios.push(this);
    }
  };
  URL.createObjectURL = vi.fn(() => "blob:greeting");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  delete globalThis.Audio;
});

describe("GreetingPreviewButton", () => {
  it("is disabled with a save hint while there are unsaved changes", () => {
    render(<GreetingPreviewButton businessId={BID} previewDirty />);
    expect(screen.getByRole("button", { name: /hear greeting/i })).toBeDisabled();
    expect(screen.getByText("Save your changes to hear them.")).toBeInTheDocument();
  });

  it("is enabled and shows no save hint when clean", () => {
    render(<GreetingPreviewButton businessId={BID} previewDirty={false} />);
    expect(screen.getByRole("button", { name: /hear greeting/i })).toBeEnabled();
    expect(screen.queryByText(/save your changes/i)).not.toBeInTheDocument();
  });

  it("fetches the clip as a blob, plays it, and cleans up when it ends", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["wav"], { type: "audio/wav" });
    api.get.mockResolvedValue({ data: blob });
    render(<GreetingPreviewButton businessId={BID} previewDirty={false} />);

    await user.click(screen.getByRole("button", { name: /hear greeting/i }));

    expect(api.get).toHaveBeenCalledWith(`/api/business/${BID}/greeting-clip`, { responseType: "blob" });
    await waitFor(() => expect(audios).toHaveLength(1));
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(audios[0].url).toBe("blob:greeting");
    expect(audios[0].play).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /stop/i })).toBeInTheDocument();

    act(() => audios[0].onended());
    expect(await screen.findByRole("button", { name: /hear greeting/i })).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:greeting");
  });

  it("says it is making the recording while it waits", async () => {
    const user = userEvent.setup();
    let resolve;
    api.get.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<GreetingPreviewButton businessId={BID} previewDirty={false} />);

    await user.click(screen.getByRole("button", { name: /hear greeting/i }));
    expect(screen.getByText("Making the recording…")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeDisabled();

    await act(async () => resolve({ data: new Blob(["x"]) }));
  });

  it("Stop pauses the audio and frees the URL", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: new Blob(["x"]) });
    render(<GreetingPreviewButton businessId={BID} previewDirty={false} />);

    await user.click(screen.getByRole("button", { name: /hear greeting/i }));
    await user.click(await screen.findByRole("button", { name: /stop/i }));

    expect(audios[0].pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:greeting");
    expect(screen.getByRole("button", { name: /hear greeting/i })).toBeInTheDocument();
  });

  it("shows the server's error text (a JSON body inside a blob)", async () => {
    const user = userEvent.setup();
    const body = new Blob([JSON.stringify({ error: "Couldn't make the greeting recording. Try again in a minute." })], {
      type: "application/json",
    });
    api.get.mockRejectedValue({ response: { status: 502, data: body } });
    render(<GreetingPreviewButton businessId={BID} previewDirty={false} />);

    await user.click(screen.getByRole("button", { name: /hear greeting/i }));

    expect(await screen.findByText("Couldn't make the greeting recording. Try again in a minute.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hear greeting/i })).toBeEnabled();
  });

  it("shows a generic error when the failure has no body", async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValue(new Error("Network Error"));
    render(<GreetingPreviewButton businessId={BID} previewDirty={false} />);

    await user.click(screen.getByRole("button", { name: /hear greeting/i }));

    expect(await screen.findByText(/couldn't play the greeting/i)).toBeInTheDocument();
  });

  it("shows an error if the browser refuses to play", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: new Blob(["x"]) });
    globalThis.Audio = class {
      constructor() {
        this.play = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
        this.pause = vi.fn();
      }
    };
    render(<GreetingPreviewButton businessId={BID} previewDirty={false} />);

    await user.click(screen.getByRole("button", { name: /hear greeting/i }));

    expect(await screen.findByText(/couldn't play the greeting/i)).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});

describe("AIBehaviorSection pronunciation editor", () => {
  const BASE = { name: "Digile Media", greeting: "", custom_instructions: "", pronunciations: {} };

  function setup(pronunciations = {}, extra = {}) {
    const onChange = vi.fn();
    render(
      <AIBehaviorSection
        value={{ ...BASE, pronunciations }}
        onChange={onChange}
        businessId={BID}
        previewDirty={false}
        {...extra}
      />
    );
    return { onChange };
  }
  const last = (fn) => fn.mock.calls.at(-1)[0];

  it("shows the preview button next to the greeting", () => {
    setup();
    expect(screen.getByRole("button", { name: /hear greeting/i })).toBeInTheDocument();
  });

  it("disables the preview when previewDirty", () => {
    setup({}, { previewDirty: true });
    expect(screen.getByRole("button", { name: /hear greeting/i })).toBeDisabled();
  });

  it("explains the box in plain words", () => {
    setup();
    expect(screen.getByText(/write it the way it sounds/i)).toBeInTheDocument();
    expect(screen.getByText(/keep the real spelling/i)).toBeInTheDocument();
  });

  it("renders existing entries (string and {say, ipa})", () => {
    setup({ Digile: "Dij-aisle", Zoë: { say: "Zoh-ee", ipa: "zoʊi" } });
    expect(screen.getAllByLabelText(/^written/i).map((i) => i.value)).toEqual(["Digile", "Zoë"]);
    expect(screen.getAllByLabelText(/say it as/i).map((i) => i.value)).toEqual(["Dij-aisle", "Zoh-ee"]);
  });

  it("adding a row emits nothing until it is filled in", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole("button", { name: /add a name/i }));
    expect(screen.getAllByLabelText(/^written/i)).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits the map once both halves are typed", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole("button", { name: /add a name/i }));
    await user.type(screen.getByLabelText(/^written/i), "Digile");
    expect(last(onChange)).toEqual({ pronunciations: {} });
    await user.type(screen.getByLabelText(/say it as/i), "Dij-aisle");
    expect(last(onChange)).toEqual({ pronunciations: { Digile: "Dij-aisle" } });
  });

  it("editing 'say it as' on an entry with an ipa drops the ipa", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } });
    await user.type(screen.getByLabelText(/say it as/i), "x");
    expect(last(onChange)).toEqual({ pronunciations: { Digile: "Dij-aislex" } });
  });

  it("editing another row keeps this row's ipa", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({
      Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" },
      Zoe: "Zoh-ee",
    });
    const says = screen.getAllByLabelText(/say it as/i);
    await user.type(says[1], "!");
    expect(last(onChange)).toEqual({
      pronunciations: { Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" }, Zoe: "Zoh-ee!" },
    });
  });

  it("renaming the written form keeps the value, ipa included", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } });
    await user.type(screen.getByLabelText(/^written/i), "s");
    expect(last(onChange)).toEqual({ pronunciations: { Digiles: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } } });
  });

  it("removing a row removes it from the map", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ Digile: "Dij-aisle", Zoe: "Zoh-ee" });
    await user.click(screen.getAllByRole("button", { name: /remove/i })[0]);
    expect(last(onChange)).toEqual({ pronunciations: { Zoe: "Zoh-ee" } });
    expect(screen.getAllByLabelText(/^written/i)).toHaveLength(1);
  });

  it("omits a row whose say was cleared", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ Digile: "Dij-aisle" });
    await user.clear(screen.getByLabelText(/say it as/i));
    expect(last(onChange)).toEqual({ pronunciations: {} });
  });

  it("stops offering 'Add a name' at 10", () => {
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Name${i}`, "ok"]));
    setup(ten);
    expect(screen.getByRole("button", { name: /add a name/i })).toBeDisabled();
  });
});
