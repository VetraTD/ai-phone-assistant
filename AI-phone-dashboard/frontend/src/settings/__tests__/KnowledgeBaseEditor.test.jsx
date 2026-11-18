import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// Imported after the mock so the component picks up the mocked module.
import { api } from "../../api";
import KnowledgeBaseEditor from "../KnowledgeBaseEditor";

const ROW = {
  id: "row-1",
  question: "Do you offer free estimates?",
  answer: "Yes, for first-time customers.",
  category: "Pricing",
  priority: 5,
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: [ROW] });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("KnowledgeBaseEditor", () => {
  it("loads and renders existing entries via GET /api/knowledge?businessId=", async () => {
    render(<KnowledgeBaseEditor businessId="biz-1" />);

    await waitFor(() => expect(screen.getByText(ROW.question)).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledWith("/api/knowledge", { params: { businessId: "biz-1" } });
  });

  it("adding an entry POSTs the trimmed form fields plus businessId", async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { ...ROW, id: "row-2" } });
    render(<KnowledgeBaseEditor businessId="biz-1" />);
    await waitFor(() => expect(screen.getByText(ROW.question)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /add q&a/i }));
    // The dashboard's filter-field labels aren't wired via htmlFor/id
    // (matches the rest of the app's form fields), so query by the fields'
    // distinct placeholder text instead of label association.
    await user.type(screen.getByPlaceholderText("e.g. Do you offer free estimates?"), "Do you take walk-ins?");
    await user.type(
      screen.getByPlaceholderText("e.g. Yes, estimates are free for all first-time customers."),
      "Yes, walk-ins welcome."
    );
    await user.click(screen.getByRole("button", { name: /add entry/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/knowledge", {
        businessId: "biz-1",
        question: "Do you take walk-ins?",
        answer: "Yes, walk-ins welcome.",
        category: null,
        priority: 0,
      })
    );
  });

  it("editing an entry PUTs to /api/knowledge/:id", async () => {
    const user = userEvent.setup();
    api.put.mockResolvedValue({ data: ROW });
    render(<KnowledgeBaseEditor businessId="biz-1" />);
    await waitFor(() => expect(screen.getByText(ROW.question)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const answerField = screen.getByPlaceholderText("e.g. Yes, estimates are free for all first-time customers.");
    await user.clear(answerField);
    await user.type(answerField, "Updated answer.");
    await user.click(screen.getByRole("button", { name: /save entry/i }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/knowledge/row-1", {
        question: ROW.question,
        answer: "Updated answer.",
        category: "Pricing",
        priority: 5,
      })
    );
  });

  it("deleting an entry confirms then DELETEs /api/knowledge/:id", async () => {
    const user = userEvent.setup();
    api.delete.mockResolvedValue({});
    render(<KnowledgeBaseEditor businessId="biz-1" />);
    await waitFor(() => expect(screen.getByText(ROW.question)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/knowledge/row-1"));
  });

  it("toggling Enabled PUTs only the enabled field", async () => {
    const user = userEvent.setup();
    api.put.mockResolvedValue({ data: { ...ROW, enabled: false } });
    render(<KnowledgeBaseEditor businessId="biz-1" />);
    await waitFor(() => expect(screen.getByText(ROW.question)).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Enabled" }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/knowledge/row-1", { enabled: false })
    );
  });
});
