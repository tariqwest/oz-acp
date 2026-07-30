import {
  ozConversationGet,
  ozRunConversation,
  ozRunGet,
} from "./oz.ts";
import { mapConversationDelta, type AcpSessionUpdate } from "./map.ts";
import { isTerminalRunState, type Session } from "./types.ts";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export type StreamEmit = (update: AcpSessionUpdate) => Promise<void> | void;

export type PollTurnResult = {
  runState: string | null;
  conversationId: string | null;
  hadUpdates: boolean;
  title: string | null;
};

export async function pollRunTurn(opts: {
  session: Session;
  runId: string;
  emit: StreamEmit;
  signal?: AbortSignal;
  intervalMs?: number;
  /** Stop polling shortly after terminal state to catch late conversation writes. */
  drainPasses?: number;
}): Promise<PollTurnResult> {
  const intervalMs = opts.intervalMs ?? 500;
  const drainPasses = opts.drainPasses ?? 3;
  let runState: string | null = null;
  let conversationId = opts.session.conversationId;
  let hadUpdates = false;
  let title = opts.session.title;
  let terminalDrains = 0;

  while (true) {
    if (opts.signal?.aborted) break;

    try {
      const run = await ozRunGet(opts.runId, { signal: opts.signal });
      runState = String(run.state);
      if (!conversationId && run.conversation_id) {
        conversationId = run.conversation_id;
        opts.session.conversationId = conversationId;
      }
      if (run.title && run.title !== title) {
        title = run.title;
        opts.session.title = title;
        await opts.emit({
          sessionUpdate: "session_info_update",
          title,
        });
        hadUpdates = true;
      }
    } catch (err) {
      if (opts.signal?.aborted) break;
      console.error("[oz-acp] WARN: run get failed:", (err as Error).message);
    }

    if (conversationId || opts.runId) {
      try {
        const conversation = conversationId
          ? await ozConversationGet(conversationId, { signal: opts.signal })
          : await ozRunConversation(opts.runId, { signal: opts.signal });

        if (!conversationId && conversation.conversation_id) {
          conversationId = conversation.conversation_id;
          opts.session.conversationId = conversationId;
        }

        const deltas = mapConversationDelta(conversation, opts.session.seenKeys);
        for (const delta of deltas) {
          opts.session.seenKeys.add(delta.key);
          await opts.emit(delta.update);
          hadUpdates = true;
        }
      } catch (err) {
        if (opts.signal?.aborted) break;
        // Conversation may not exist until shortly after run starts.
        const msg = (err as Error).message || "";
        if (!/not found|404|empty stdout/i.test(msg)) {
          console.error("[oz-acp] WARN: conversation poll failed:", msg);
        }
      }
    }

    if (runState && isTerminalRunState(runState)) {
      terminalDrains += 1;
      if (terminalDrains > drainPasses) break;
    }

    try {
      await sleep(intervalMs, opts.signal);
    } catch {
      break;
    }
  }

  return {
    runState,
    conversationId,
    hadUpdates,
    title,
  };
}
