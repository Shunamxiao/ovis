import { describe, expect, it } from "bun:test";
import { cachedPaneCells, orderedPaneCells, visitPaneTab } from "./paneTabCache.ts";

describe("pane tab cache", () => {
  const liveTabs = new Set(["a", "b", "c", "d", "e"]);
  it("keeps three previous tabs and promotes a return without duplicates", () => {
    const visits = ["d", "c", "b", "a"];
    expect(visitPaneTab(visits, "e", liveTabs)).toEqual(["e", "d", "c", "b"]);
    expect(visitPaneTab(visits, "b", liveTabs)).toEqual(["b", "d", "c", "a"]);
    expect(visitPaneTab(visits, "d", liveTabs)).toEqual(visits);
  });
  it("drops closed tabs and leaves unvisited tabs cold", () => {
    expect(visitPaneTab(["c", "b", "a"], "b", new Set(["a", "b", "d"]))).toEqual(["b", "a"]);
    expect(visitPaneTab([], "a", liveTabs)).toEqual(["a"]);
    expect(visitPaneTab(["a"], null, new Set())).toEqual([]);
  });
  it("preserves last geometry but drops closed, moved and never mounted panes", () => {
    const cell = { paneId: "a1", left: 0, top: 0, width: 100, height: 100, focused: true };
    const last = new Map([["a1", cell], ["closed", { ...cell, paneId: "closed" }], ["moved", { ...cell, paneId: "moved" }]]);
    const panes = [{ pane_id: "a1", tab_id: "a" }, { pane_id: "new", tab_id: "a" }, { pane_id: "moved", tab_id: "e" }];
    expect(cachedPaneCells(["b", "a"], "b", panes, last, new Set())).toEqual([cell]);
    expect(cachedPaneCells(["b", "a"], "b", panes, last, new Set(["a1"]))).toEqual([]);
    expect(cachedPaneCells(["a", "b"], "a", panes, last, new Set())).toEqual([]);
  });
  it("keeps PC canvas histories independent", () => {
    const first = visitPaneTab(["b"], "a", liveTabs);
    const second = visitPaneTab([], "c", liveTabs);
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["c"]);
  });
  it("keeps every mounted pane where it already was, so switching a tab moves no frame", () => {
    const cell = (paneId: string) => ({ paneId });
    // t2 presented after t1: the presented pane comes first in the mount list, yet stays second in the DOM
    expect(orderedPaneCells(["t1", "t2"], [cell("t2"), cell("t1")]).map((item) => item.paneId)).toEqual(["t1", "t2"]);
    // a first render, and a new pane, keep the mount list's own order
    expect(orderedPaneCells([], [cell("t2"), cell("t1")]).map((item) => item.paneId)).toEqual(["t2", "t1"]);
    expect(orderedPaneCells(["t1", "t2"], [cell("t3"), cell("t2")]).map((item) => item.paneId)).toEqual(["t2", "t3"]);
  });
});
