import { describe, it, expect } from "vitest";
import { swapConnectionOrder, swappedPriorityWrites } from "@/shared/utils/swapConnectionOrder.js";

function ids(list) {
  return list.map((row) => row.id);
}

function ranks(list) {
  return list.map((row) => row.priority);
}

describe("swapConnectionOrder", () => {
  const list = [
    { id: "a", priority: 1 },
    { id: "b", priority: 2 },
    { id: "c", priority: 3 },
  ];

  it("moves a middle row up one slot with 1-based ranks", () => {
    const next = swapConnectionOrder(list, 2, 1);

    expect(ids(next)).toEqual(["a", "c", "b"]);
    expect(ranks(next)).toEqual([1, 2, 3]);
  });

  it("moves a middle row down one slot with 1-based ranks", () => {
    const next = swapConnectionOrder(list, 1, 2);

    expect(ids(next)).toEqual(["a", "c", "b"]);
    expect(ranks(next)).toEqual([1, 2, 3]);
  });

  it("moves the second row to the top without skipping", () => {
    const next = swapConnectionOrder(list, 1, 0);

    expect(ids(next)).toEqual(["b", "a", "c"]);
    expect(ranks(next)).toEqual([1, 2, 3]);
  });

  it("emits 1-based writes for every visible slot", () => {
    const next = swapConnectionOrder(list, 2, 1);
    expect(swappedPriorityWrites(next)).toEqual([
      { id: "a", priority: 1 },
      { id: "c", priority: 2 },
      { id: "b", priority: 3 },
    ]);
  });

  it("restamps tied ranks so a top swap does not skip", () => {
    const tied = [
      { id: "a", priority: 1 },
      { id: "b", priority: 1 },
      { id: "c", priority: 1 },
    ];
    const next = swapConnectionOrder(tied, 1, 0);
    expect(ids(next)).toEqual(["b", "a", "c"]);
    expect(ranks(next)).toEqual([1, 2, 3]);
  });



  it("does not mutate the original list", () => {
    const snapshot = list.map((row) => ({ ...row }));
    swapConnectionOrder(list, 2, 1);
    expect(list).toEqual(snapshot);
  });

  it("returns null for an out-of-range or non-swap", () => {
    expect(swapConnectionOrder(list, 0, -1)).toBeNull();
    expect(swapConnectionOrder(list, 0, 3)).toBeNull();
    expect(swapConnectionOrder(list, 1, 1)).toBeNull();
    expect(swapConnectionOrder([], 0, 1)).toBeNull();
  });

});
