import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Terminal } from "@xterm/xterm";
import type { PaneScrollInfo } from "../../shared/protocol.ts";
import * as machineContext from "../lib/machineContext.tsx";
import * as settingsModule from "../lib/settings.ts";
import { SCROLL_POLL_BUSY_MS } from "../lib/terminalViewport.ts";
import { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { TerminalViewportTools } from "./TerminalViewportTools.tsx";

/** herdr's side of the view: every metrics read and scroll write waits until the test answers it, and is answered
 * from herdr's state at that moment (a program on its alternate screen leaves no history: offset and maximum 0) */
function fakeHerdr(max: number) {
  let offset = 0, alternate = false;
  const reads: ((metrics: PaneScrollInfo) => void)[] = [];
  const writes: { target: number; resolve: (metrics: PaneScrollInfo) => void; reject: (error: Error) => void }[] = [];
  const targets: number[] = [];
  const metrics = (): PaneScrollInfo => alternate
    ? { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 }
    : { offset_from_bottom: offset, max_offset_from_bottom: max, viewport_rows: 24 };
  const nextWrite = () => {
    const write = writes.shift();
    if (!write) throw new Error("no scroll write is waiting");
    return write;
  };
  return {
    get offset() { return offset; },
    targets,
    enterAlternateScreen() { alternate = true; },
    api: {
      fetchPaneScroll: () => new Promise<PaneScrollInfo>((resolve) => { reads.push(resolve); }),
      scrollPane: (_pane: string, target: number) => {
        targets.push(target);
        return new Promise<PaneScrollInfo>((resolve, reject) => { writes.push({ target, resolve, reject }); });
      },
    },
    writing: () => writes.length > 0,
    /** applies the oldest write; `movedTo`: herdr's view then moves there before the answer (output under a held view);
     * null: the answer carries no metrics */
    answerWrite(movedTo?: number | null) {
      const write = nextWrite();
      if (!alternate) offset = Math.max(0, Math.min(max, write.target));
      if (typeof movedTo === "number") offset = movedTo;
      write.resolve(movedTo === null ? null as unknown as PaneScrollInfo : metrics());
    },
    failWrite() { nextWrite().reject(new Error("herdr refused the scroll")); },
    answerReads() { for (const resolve of reads.splice(0)) resolve(metrics()); },
  };
}

describe("history scrolls by every wheel line while the view's own writes are slow, and page keys go where they did", () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    for (const key of ["document", "getComputedStyle", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
    define("getComputedStyle", () => ({ visibility: "visible" }));
    define("ResizeObserver", class { observe() {} disconnect() {} });
    spyOn(settingsModule, "useSettings").mockReturnValue({
      settings: settingsModule.DEFAULT_SETTINGS, resolvedLanguage: "en",
    } as ReturnType<typeof settingsModule.useSettings>);
  });

  afterEach(() => {
    act(() => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function mount(herdr: ReturnType<typeof fakeHerdr>) {
    spyOn(machineContext, "useMachineApi").mockReturnValue(herdr.api as unknown as ReturnType<typeof machineContext.useMachineApi>);
    const written: (() => void)[] = [];
    const listener = () => ({ dispose() {} });
    // the grid and its layer have a size, so the Jump to bottom button is drawn
    const rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
    const screen = { getBoundingClientRect: () => rect };
    const terminal = {
      element: { getClientRects: () => [rect], querySelector: () => screen, parentElement: null, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true },
      cols: 80, rows: 24,
      buffer: { active: { viewportY: 0, baseY: 0, getLine: () => undefined } },
      onWriteParsed: (callback: () => void) => { written.push(callback); return { dispose() {} }; },
      onScroll: listener, onRender: listener, onResize: listener,
    } as unknown as Terminal;
    const lineScroll: { current: ((lines: number) => void) | null } = { current: null };
    const pageScroll: { current: ((direction: -1 | 1) => void) | null } = { current: null };
    const errors: string[] = [];
    const programPages: number[] = [];
    await act(async () => {
      renderer = create(createElement(TerminalViewportTools, {
        viewportIntent: new ViewportIntentGate(), terminal, paneId: "w1:p1", lineScroll, pageScroll,
        onApplicationPage: (direction: -1 | 1) => { programPages.push(direction); },
        enabled: true, interactive: true, search: null, onError: (message: string) => { errors.push(message); },
      }), { createNodeMock: () => ({ parentElement: screen }) });
    });
    const start = Date.now();
    const at = (ms: number) => act(async () => { jest.advanceTimersByTime(start + ms - Date.now()); });
    return {
      errors,
      /** page keys the view handed to the program on its alternate screen */
      programPages,
      /** moves the clock to `ms` after mounting, running the poll timers due on the way */
      at,
      wheel: (lines: number) => act(async () => { lineScroll.current!(lines); }),
      page: (direction: -1 | 1) => act(async () => { pageScroll.current!(direction); }),
      jumpToBottom: () => act(async () => { renderer!.root.findByProps({ "aria-label": "Jump to bottom" }).props.onClick(); }),
      /** a chunk of output parsed, as herdr's repaint of a moved view arrives */
      output: () => act(async () => { for (const callback of written) callback(); }),
      answerWrite: (movedTo?: number | null) => act(async () => { herdr.answerWrite(movedTo); }),
      failWrite: () => act(async () => { herdr.failWrite(); }),
      answerReads: () => act(async () => { herdr.answerReads(); }),
      /** answers every read and write as they come, through `until` ms after mounting */
      async answerAll(until: number) {
        while (herdr.writing()) await act(async () => { herdr.answerWrite(); });
        for (let ms = Date.now() - start + 100; ms <= until; ms += 100) {
          await at(ms);
          await act(async () => { herdr.answerReads(); });
          while (herdr.writing()) await act(async () => { herdr.answerWrite(); });
        }
      },
    };
  }

  it("applies every wheel line asked while the view's writes outlast the busy cadence, though the wheel keeps reads waiting past the hold", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    let asked = 0;
    const wheel = async () => { asked += 3; await view.wheel(3); };
    // Given: a wheel's write in flight, and output (herdr repainting the moved view) since its metrics were read
    await view.at(10);
    await wheel();
    expect(herdr.writing()).toBe(true);
    await view.output();
    await view.at(100);
    await wheel();
    // When: a line more than the busy cadence after the metrics in use began, while that write is still out, and the
    // wheel going on for over a second, each write answered only after the next line, so no read can start in between
    await view.at(10 + SCROLL_POLL_BUSY_MS + 40);
    await wheel();
    for (let ms = 350; ms <= 1500; ms += 50) {
      await view.at(ms);
      await wheel();
      if (herdr.writing()) await view.answerWrite();
      await view.output();
    }
    await view.answerAll(3000);
    // Then: herdr's view moved by every line asked
    expect(herdr.offset).toBe(asked);
    expect(herdr.targets.at(-1)).toBe(asked);
    expect(view.errors).toEqual([]);
  });

  it("holds a line and a page on stale metrics while nothing of the view is in flight, until a read", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    // Given: output since the metrics were read, and no write out
    await view.output();
    // When: a line and a page past the busy cadence
    await view.at(10 + SCROLL_POLL_BUSY_MS + 40);
    await view.wheel(3);
    await view.page(-1);
    await view.at(10 + SCROLL_POLL_BUSY_MS + 50);
    // Then: nothing is written before a read answers, and both apply after it
    expect(herdr.targets).toEqual([]);
    await view.answerAll(3000);
    expect(herdr.offset).toBe(herdr.targets[0]! + 3);
    expect(view.programPages).toEqual([]);
  });

  /** a page's write out, then the program entering its alternate screen, then PageUp past the busy cadence */
  async function pageAfterSwitch(herdr: ReturnType<typeof fakeHerdr>) {
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10);
    await view.page(-1);
    await view.output();
    await view.at(200);
    herdr.enterAlternateScreen();
    await view.output();
    await view.at(300);
    await view.page(-1);
    return view;
  }

  it("gives a page key pressed during a write past the program's switch to its alternate screen to the program after a read", async () => {
    const herdr = fakeHerdr(300);
    const view = await pageAfterSwitch(herdr);
    await view.answerAll(3000);
    expect(herdr.targets).toEqual([herdr.targets[0]!]);
    expect(view.programPages).toEqual([-1]);
  });

  it("drops that page key when the write is answered only after the hold has passed", async () => {
    const herdr = fakeHerdr(300);
    const view = await pageAfterSwitch(herdr);
    await view.at(3000);
    await view.answerAll(6000);
    expect(herdr.targets).toEqual([herdr.targets[0]!]);
    expect(view.programPages).toEqual([]);
  });

  it("gives that page key to the program after a read when the write fails", async () => {
    const herdr = fakeHerdr(300);
    const view = await pageAfterSwitch(herdr);
    await view.at(400);
    await view.failWrite();
    await view.answerAll(3000);
    expect(view.errors).toHaveLength(1);
    expect(view.programPages).toEqual([-1]);
  });

  it("gives that page key to the program after a read though Jump to bottom comes before the write's answer", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10);
    await view.page(-1);
    await view.output();
    await view.at(20);
    await view.answerWrite();
    await view.at(30);
    await view.page(-1);
    await view.output();
    await view.at(150);
    herdr.enterAlternateScreen();
    await view.output();
    await view.at(300);
    await view.page(-1);
    await view.at(350);
    await view.jumpToBottom();
    await view.answerAll(3000);
    expect(herdr.targets).toEqual([23, 46, 0]);
    expect(view.programPages).toEqual([-1]);
  });

  it("gives a page key pressed with a wheel line during a write the page path after a read, though the next write would outlast its hold", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    // Given: a wheel write out, and output since the metrics were read
    await view.at(10);
    await view.answerReads();
    await view.wheel(3);
    await view.output();
    // When: a wheel line and a PageUp past the busy cadence, the write answered at 400 ms, and nothing herdr is asked
    // after that answered before 1100 ms
    await view.at(10 + SCROLL_POLL_BUSY_MS + 50);
    await view.wheel(3);
    await view.page(-1);
    await view.at(400);
    await view.answerWrite();
    await view.at(1100);
    await view.answerAll(4000);
    // Then: the page and the line both applied, the page first, as on main
    expect(herdr.targets).toEqual([3, 26, 29]);
    expect(herdr.offset).toBe(29);
  });

  it("applies a wheel line asked on stale metrics during a write that fails, after a read", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10);
    await view.wheel(3);
    await view.output();
    await view.at(10 + SCROLL_POLL_BUSY_MS + 40);
    await view.wheel(3);
    await view.failWrite();
    await view.answerAll(3000);
    // the failed write's own lines are gone, as on main; the later line applies
    expect(view.errors).toHaveLength(1);
    expect(herdr.offset).toBe(3);
  });

  /** a wheel write out, output, then a wheel line and a PageUp past the busy cadence: the page is held, the line queued */
  async function wheelAndPageDuringWrite(herdr: ReturnType<typeof fakeHerdr>) {
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10);
    await view.answerReads();
    await view.wheel(3);
    await view.output();
    await view.at(10 + SCROLL_POLL_BUSY_MS + 50);
    await view.wheel(3);
    await view.page(-1);
    await view.at(400);
    return view;
  }

  it("counts the line queued with a held page from the target it joined, though herdr's view moved before the answer", async () => {
    const herdr = fakeHerdr(300);
    const view = await wheelAndPageDuringWrite(herdr);
    // When: herdr applied the write to 3, and output moved its view to 12 before it answered
    await view.answerWrite(12);
    await view.answerAll(3000);
    // Then: the page from 12, then the one queued line up: 12 + 23 + 3, never back down
    expect(herdr.targets).toEqual([3, 35, 38]);
    expect(herdr.offset).toBe(38);
  });

  it("counts the line queued with a held page from the target it joined, though the write's answer carries no metrics", async () => {
    const herdr = fakeHerdr(300);
    const view = await wheelAndPageDuringWrite(herdr);
    // When: herdr applied the write to 3 and answered without metrics
    await view.answerWrite(null);
    await view.answerAll(3000);
    // Then: the first write's lines are not applied again: 3 + 23 + 3
    expect(herdr.offset).toBe(29);
  });
});
