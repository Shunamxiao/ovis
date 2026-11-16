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
  const writes: { target: number; resolve: (metrics: PaneScrollInfo) => void }[] = [];
  const targets: number[] = [];
  const metrics = (): PaneScrollInfo => alternate
    ? { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 }
    : { offset_from_bottom: offset, max_offset_from_bottom: max, viewport_rows: 24 };
  return {
    get offset() { return offset; },
    targets,
    enterAlternateScreen() { alternate = true; },
    growHistory(lines: number) { max += lines; },
    api: {
      fetchPaneScroll: () => new Promise<PaneScrollInfo>((resolve) => { reads.push(resolve); }),
      scrollPane: (_pane: string, target: number) => {
        targets.push(target);
        return new Promise<PaneScrollInfo>((resolve) => { writes.push({ target, resolve }); });
      },
    },
    writing: () => writes.length > 0,
    answerWrite() {
      const write = writes.shift();
      if (!write) throw new Error("no scroll write is waiting");
      if (!alternate) offset = Math.max(0, Math.min(max, write.target));
      write.resolve(metrics());
    },
    answerReads() { for (const resolve of reads.splice(0)) resolve(metrics()); },
  };
}

describe("history scrolls by every wheel line and page while the view's own writes are slow", () => {
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
    const terminal = {
      element: { getClientRects: () => [{}], querySelector: () => null, parentElement: null, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true },
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
      }));
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
      /** a chunk of output parsed, as herdr's repaint of a moved view arrives */
      output: () => act(async () => { for (const callback of written) callback(); }),
      answerWrite: () => act(async () => { herdr.answerWrite(); }),
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

  /**
   * The gesture behind the fault: each step starts or joins a write of the view, output (herdr repainting the moved
   * view) follows it, one step comes more than the busy cadence after the metrics in use began while that write is
   * still out, and the steps go on for more than a second, each write answered only after the next step is asked, so
   * no metrics read can start in between. Then the reads that follow the gesture, well past the hold.
   */
  async function slowWritesGesture(view: Awaited<ReturnType<typeof mount>>, herdr: ReturnType<typeof fakeHerdr>, step: () => Promise<void>) {
    await view.answerReads();
    // Given: a write in flight, and output since its metrics were read
    await view.at(10);
    await step();
    expect(herdr.writing()).toBe(true);
    await view.output();
    await view.at(100);
    await step();
    // When: a step past the busy cadence while that write is still out, and more steps for over a second
    await view.at(10 + SCROLL_POLL_BUSY_MS + 40);
    await step();
    for (let ms = 350; ms <= 1500; ms += 50) {
      await view.at(ms);
      await step();
      if (herdr.writing()) await view.answerWrite();
      await view.output();
    }
    while (herdr.writing()) await view.answerWrite();
    for (let ms = 1600; ms <= 3000; ms += 100) {
      await view.at(ms);
      await view.answerReads();
      while (herdr.writing()) await view.answerWrite();
    }
  }

  it("applies every wheel line asked while the view's writes outlast the busy cadence", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    let asked = 0;
    await slowWritesGesture(view, herdr, async () => { asked += 3; await view.wheel(3); });
    // Then: herdr's view moved by every line asked
    expect(herdr.offset).toBe(asked);
    expect(herdr.targets.at(-1)).toBe(asked);
    expect(view.errors).toEqual([]);
  });

  it("applies every page of a held-down PageUp while the view's writes outlast the busy cadence", async () => {
    const herdr = fakeHerdr(5000);
    const view = await mount(herdr);
    let pages = 0;
    await slowWritesGesture(view, herdr, async () => { pages += 1; await view.page(-1); });
    // Then: herdr's view moved by every page asked, each the first one's distance
    const distance = herdr.targets[0]!;
    expect(herdr.offset).toBe(pages * distance);
    expect(view.errors).toEqual([]);
  });

  it("gives a page key pressed during a write to the program when that write's answer shows its alternate screen", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    // Given: a page's write in flight, then the program entering its alternate screen
    await view.at(10);
    await view.page(-1);
    await view.output();
    await view.at(200);
    herdr.enterAlternateScreen();
    await view.output();
    // When: a page key past the busy cadence, before that write is answered with no history
    await view.at(300);
    await view.page(-1);
    await view.answerAll(3000);
    // Then: the key went to the program after a read, not to herdr as one more scroll
    expect(herdr.targets).toEqual([herdr.targets[0]!]);
    expect(view.programPages).toEqual([-1]);
  });

  it("gives the program the page keys pressed during a write sent before its alternate screen and answered after", async () => {
    const herdr = fakeHerdr(300);
    const view = await mount(herdr);
    await view.answerReads();
    await view.at(10);
    await view.page(-1);
    await view.output();
    await view.at(50);
    await view.page(-1);
    // Given: the first write answered with history, the second out when the program enters its alternate screen
    await view.at(100);
    await view.answerWrite();
    await view.at(150);
    herdr.enterAlternateScreen();
    await view.output();
    // When: two keys during that write, and one more after its answer
    await view.at(400);
    await view.page(-1);
    await view.at(500);
    await view.page(-1);
    await view.answerWrite();
    await view.at(600);
    await view.page(-1);
    await view.answerAll(3000);
    // Then: the program got all three, and herdr no scroll after the switch
    expect(herdr.targets).toHaveLength(2);
    expect(view.programPages).toEqual([-1, -1, -1]);
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
    const distance = herdr.targets[0]!;
    expect(herdr.offset).toBe(distance + 3);
    expect(view.programPages).toEqual([]);
  });

  it("gives back the lines the cached top cut off once the write's answer shows the history grew", async () => {
    const herdr = fakeHerdr(100);
    const view = await mount(herdr);
    await view.answerReads();
    // Given: a write in flight near the top, and the history growing by 20 lines meanwhile
    await view.at(10);
    await view.wheel(99);
    await view.at(100);
    herdr.growHistory(20);
    await view.output();
    // When: five lines up past the busy cadence, above the top the view last read
    await view.at(10 + SCROLL_POLL_BUSY_MS + 40);
    await view.wheel(5);
    await view.answerAll(3000);
    // Then: all five apply on the grown history, and the wheel goes on from there
    expect(herdr.offset).toBe(104);
    await view.wheel(3);
    await view.answerAll(4000);
    expect(herdr.offset).toBe(107);
  });
});
