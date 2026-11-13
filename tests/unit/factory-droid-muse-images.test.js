import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Droid 1.10.0 drops images:false from Muse Spark 1.2 and 1.3, so it sends
// images to both, as it already did to Muse Spark Open.
describe("Factory Muse Spark image input from Droid 1.10.0", () => {
  it("accepts images on Muse Spark 1.2, 1.3, and Open", () => {
    for (const model of ["muse-spark-1.2", "muse-spark-1.3", "muse-spark-open"]) {
      expect(getCapabilitiesForModel("factory", model).vision, model).toBe(true);
    }
  });
});
