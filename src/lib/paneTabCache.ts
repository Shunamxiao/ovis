import type { LayoutCell } from "./layoutMap.ts";

export function visitPaneTab(previous: readonly string[], current: string | null, liveTabs: ReadonlySet<string>): readonly string[] {
  const surviving = previous.filter((id) => liveTabs.has(id) && id !== current);
  return current !== null && liveTabs.has(current) ? [current, ...surviving].slice(0, 4) : surviving.slice(0, 4);
}

/** Only previously mounted panes survive: new hidden splits must not acquire an attach. */
export function cachedPaneCells(
  tabs: readonly string[], current: string | null,
  panes: readonly { readonly pane_id: string; readonly tab_id: string }[],
  lastCells: ReadonlyMap<string, LayoutCell>, shownIds: ReadonlySet<string>,
): LayoutCell[] {
  const cachedTabs = new Set(tabs.filter((id) => id !== current));
  return panes.flatMap((pane) => {
    const cell = lastCells.get(pane.pane_id);
    return cachedTabs.has(pane.tab_id) && !shownIds.has(pane.pane_id) && cell ? [cell] : [];
  });
}

/**
 * The order panes keep in the canvas: a keyed child that changes rank is moved in the DOM by React,
 * and moving a frame resets the scrollTop of everything it scrolls (the chat view lands on its
 * oldest row), so each mounted pane holds the place it had last render. A new pane goes last and a
 * closed one drops out; sorting is stable, so two new panes keep their own order.
 */
export function orderedPaneCells<T extends { readonly paneId: string }>(previous: readonly string[], cells: readonly T[]): T[] {
  const rank = new Map(previous.map((id, index) => [id, index]));
  const last = Number.MAX_SAFE_INTEGER;
  return [...cells].sort((a, b) => (rank.get(a.paneId) ?? last) - (rank.get(b.paneId) ?? last));
}
