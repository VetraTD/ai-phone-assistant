import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Field from "../Field";

describe("Field labels", () => {
  it("says 'optional' as a separate word, not run into the label", () => {
    render(<Field label="Greeting" optional>{(p) => <input {...p} />}</Field>);
    expect(screen.getByRole("textbox", { name: "Greeting optional" })).toBeInTheDocument();
  });

  it("says 'Recommended' as a separate word too", () => {
    render(<Field label="About your business" recommended>{(p) => <input {...p} />}</Field>);
    expect(screen.getByRole("textbox", { name: "About your business Recommended" })).toBeInTheDocument();
  });
});
