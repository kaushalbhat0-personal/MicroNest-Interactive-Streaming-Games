import { describe, expect, it } from "vitest";
import { recoverySteps } from "../src/dashboard/settings";

describe("reauthorization recovery guidance (T3)", () => {
  it("asks for re-consent when the grant lacks outbound permission", () => {
    const rec = recoverySteps({ source: "youtube", ytStatus: "STREAMING", outbound: "insufficient" });
    expect(rec[0]).toContain("Authorize with Google");
    expect(rec.join(" ")).toContain("Reading chat keeps working");
  });

  it("leaves existing guidance untouched otherwise", () => {
    expect(recoverySteps({ source: "youtube", ytStatus: "STREAMING" })).toEqual([
      "Chat is arriving — no recovery needed. If commands stop landing, check the broadcast is still live.",
    ]);
    expect(recoverySteps({ source: "youtube", ytStatus: "AUTH_REQUIRED" })[0]).toContain("Authorize with Google");
    expect(recoverySteps({ source: "simulation", ytStatus: "off" })).toEqual([
      "Select YouTube Live as the input source above to begin setup.",
    ]);
  });
});
