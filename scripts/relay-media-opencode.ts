import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrRpc, sessionSnapshot, subscribeEvents } from "../server/herdr/client.ts";

export async function startRelayMediaOpenCode(pane: string, dir: string): Promise<void> {
  const standIn = join(dir, "opencode");
  writeFileSync(standIn, "#!/bin/sh\nwhile read -r line; do :; done\n");
  chmodSync(standIn, 0o755);

  const started = Promise.withResolvers<void>();
  const named = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  let execSent = false;
  let last = "not read";
  const readRoster = async (): Promise<void> => {
    const afterExec = execSent;
    const entry = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane);
    last = entry ? `agent=${JSON.stringify(entry.agent ?? null)}, status=${entry.agent_status}` : "pane missing";
    if (afterExec && entry?.agent === "opencode") named.resolve();
  };

  // Foreground detection can change the roster's agent label without changing the pane name,
  // status, or presentation, so the old pane.updated and pane.agent_status_changed wait missed it.
  const subscription = subscribeEvents([{ type: "pane.agent_detected" }], {
    onStarted: started.resolve,
    onError: failed.reject,
    onClose: () => failed.reject(new Error(`Herdr closed the OpenCode detection subscription for ${pane}`)),
    onEvent: ({ data }) => {
      if (data?.["pane_id"] === pane) void readRoster().catch(failed.reject);
    },
  });
  const timer = setTimeout(() => failed.reject(
    new Error(`Timed out: stand-in OpenCode foreground process for ${pane} (last roster: ${last})`),
  ), 30_000);
  try {
    await Promise.race([started.promise, failed.promise]);
    await Promise.race([readRoster(), failed.promise]);
    execSent = true;
    await Promise.race([herdrRpc("pane.send_text", { pane_id: pane, text: `exec ${JSON.stringify(standIn)}\n` }), failed.promise]);
    await Promise.race([readRoster(), failed.promise]);
    await Promise.race([named.promise, failed.promise]);
  } finally {
    clearTimeout(timer);
    subscription.close();
  }
}
