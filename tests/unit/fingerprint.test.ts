import { describe, expect, it } from "vitest";
import { hammingDistance } from "@/lib/fingerprint";

describe("hammingDistance", () => {
  it("is 0 for identical hashes", () => expect(hammingDistance("e31ab2c4ca385545", "e31ab2c4ca385545")).toBe(0));
  it("counts differing bits", () => {
    expect(hammingDistance("0", "f")).toBe(4);
    expect(hammingDistance("e31ab2c4ca385545", "911ab2d6da451009")).toBe(19);
  });
});
