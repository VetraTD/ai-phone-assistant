import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import CallOutcomeAnswers from "../components/CallOutcomeAnswers";
import { buildCallsCsv } from "../callsCsv";
import { TRANSLATIONS } from "../LanguageSwitcher";

describe("CallOutcomeAnswers", () => {
  it("shows the humanised outcome and the answers as rows", () => {
    render(
      <CallOutcomeAnswers
        call={{ outcome_code: "held_for_review", answers: { best_time: "Tuesday morning", budget_range: "5k" } }}
      />
    );
    expect(screen.getByText("Held for review")).toBeInTheDocument();
    expect(screen.getByText("Best time")).toBeInTheDocument();
    expect(screen.getByText("Tuesday morning")).toBeInTheDocument();
    expect(screen.getByText("Budget range")).toBeInTheDocument();
    expect(screen.getByText("5k")).toBeInTheDocument();
  });

  it("humanises opted_out", () => {
    render(<CallOutcomeAnswers call={{ outcome_code: "opted_out", answers: null }} />);
    expect(screen.getByText("Opted out")).toBeInTheDocument();
  });

  it("hides internal underscore keys and shows _outcome_note as a Note", () => {
    render(
      <CallOutcomeAnswers
        call={{
          outcome_code: "qualified",
          answers: { q1: "yes", _internal_flag: "SECRET-INTERNAL", _outcome_note: "Wants a callback Friday" },
        }}
      />
    );
    expect(screen.queryByText("SECRET-INTERNAL")).toBeNull();
    expect(screen.queryByText(/internal flag/i)).toBeNull();
    expect(screen.queryByText(/outcome note/i)).toBeNull();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("Wants a callback Friday")).toBeInTheDocument();
    expect(screen.getByText("yes")).toBeInTheDocument();
  });

  it("shows answers on an inbound call with no outcome_code", () => {
    render(<CallOutcomeAnswers call={{ direction: "inbound", outcome_code: null, answers: { name: "Sam" } }} />);
    expect(screen.getByText("Sam")).toBeInTheDocument();
    expect(screen.queryByText("Outcome")).toBeNull();
  });

  it("renders nothing without outcome_code and answers", () => {
    for (const call of [
      { outcome_code: null, answers: null },
      { outcome_code: null, answers: {} },
      { outcome_code: null, answers: { _hidden: "x" } },
      {},
    ]) {
      const { container, unmount } = render(<CallOutcomeAnswers call={call} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("renders text, never markup", () => {
    const { container } = render(
      <CallOutcomeAnswers call={{ outcome_code: "x", answers: { q: "<img src=x onerror=alert(1)>" } }} />
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});

describe("buildCallsCsv", () => {
  it("adds direction and outcome columns", () => {
    const csv = buildCallsCsv([
      { started_at: "2026-09-29T10:00:00Z", caller_number: "+1555", direction: "outbound", status: "completed", outcome_code: "opted_out", duration_seconds: 12, sentiment: "neutral", summary: "hi" },
    ]);
    const [head, row] = csv.split("\r\n");
    expect(head).toBe("Date,Caller,Direction,Status,Outcome,Duration (s),Sentiment,Summary");
    expect(row).toBe("2026-09-29T10:00:00.000Z,+1555,outbound,completed,opted_out,12,neutral,hi");
  });

  it("returns null for no calls", () => {
    expect(buildCallsCsv([])).toBeNull();
  });
});

describe("translations", () => {
  it("has every new key in English (the only interface language)", () => {
    const keys = ["filterDirection", "filterInbound", "filterOutbound", "directionInbound", "directionOutbound", "infoDirection", "outcomeAnswersTitle", "outcomeLabel", "outcomeNoteLabel"];
    for (const k of keys) expect(TRANSLATIONS.en[k], `en.${k}`).toBeTruthy();
  });
});
