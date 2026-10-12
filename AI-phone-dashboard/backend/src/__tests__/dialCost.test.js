describe("dialCost vendored into the dashboard", () => {
  it("loads as ESM and checks numbers", async () => {
    const m = await import("../dialCost.mjs");
    expect(m.checkDial("+442079460958").ok).toBe(true);
    expect(m.checkDial("+449090123456").reason).toBe("never");
  });
});
