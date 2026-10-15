/**
 * OpenTelemetry ACP Telemetry Fix.
 * Listens to ACP session prompt streams and exports turn spans, tool child spans,
 * and Antigravity CLI log events in the background.
 */

import {
  ACP_METHODS,
  SESSION_UPDATES,
  isJsonRpcErrorResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcSuccessResponse,
  type AcpFix,
  type AcpStreamMessage,
  type InboundContext,
  type JsonRpcRequest,
  type JsonRpcValidResponse,
  type OutboundContext,
  type SessionPromptParams,
  type SessionUpdateParams,
} from "../core/types.js";
import { extractSessionId } from "../core/session-cache.js";
import { getOtelConfig, type OtelConfig } from "./config.js";
import { OtlpExporter, type IOtelExporter } from "./exporter.js";
import { SessionTurnTracker } from "./tracker.js";

function handlePromptResponse(
  msg: JsonRpcValidResponse,
  sessionId: string,
  tracker: SessionTurnTracker,
  customDbPath?: string,
): void {
  if (isJsonRpcErrorResponse(msg)) {
    tracker.finishTurn(sessionId, {
      promptRequestId: msg.id,
      isError: true,
      errorMessage: msg.error.message,
      customDbPath,
    });
    return;
  }

  const resultObj =
    msg.result && typeof msg.result === "object" ? (msg.result as Record<string, unknown>) : {};
  const stopReason = typeof resultObj.stopReason === "string" ? resultObj.stopReason : undefined;
  const usage = resultObj.usage as
    | { inputTokens?: number; outputTokens?: number; cachedTokens?: number }
    | undefined;

  if (usage) {
    tracker.recordExplicitUsage(sessionId, usage);
  }

  tracker.finishTurn(sessionId, {
    promptRequestId: msg.id,
    stopReason,
    customDbPath,
  });
}

function handleToolUpdate(
  update: NonNullable<SessionUpdateParams["update"]>,
  sessionId: string,
  tracker: SessionTurnTracker,
): void {
  const call = update as {
    toolCallId?: string;
    callId?: string;
    id?: string;
    title?: string;
    tool?: string;
    name?: string;
    status?: string;
  };
  const callId = call.toolCallId || call.callId || call.id;
  if (!callId) return;

  if (update.sessionUpdate === SESSION_UPDATES.TOOL_CALL) {
    tracker.recordToolCall(sessionId, callId, call.title || call.tool || call.name || "tool");
  } else if (update.sessionUpdate === SESSION_UPDATES.TOOL_CALL_UPDATE && call.status) {
    tracker.updateToolCall(sessionId, callId, call.status);
  }
}

function handleNonToolUpdate(
  update: NonNullable<SessionUpdateParams["update"]>,
  sessionId: string,
  tracker: SessionTurnTracker,
): void {
  const su = update.sessionUpdate;
  if (su === SESSION_UPDATES.AGENT_MESSAGE_CHUNK) {
    const text = (update as { content?: { text?: string } }).content?.text;
    if (typeof text === "string") tracker.appendResponseChunk(sessionId, text);
  } else if (su === SESSION_UPDATES.USAGE_UPDATE) {
    const usage = update as { used?: number; size?: number };
    if (typeof usage.used === "number")
      tracker.recordUsageUpdate(sessionId, usage.used, usage.size);
  } else if (su === SESSION_UPDATES.CONFIG_OPTION_UPDATE) {
    const configOpt = update as { configId?: string; value?: unknown };
    if (configOpt.configId === "model" && typeof configOpt.value === "string") {
      tracker.setModel(sessionId, configOpt.value);
    }
  }
}

function handleUpdate(
  params: SessionUpdateParams,
  tracker: SessionTurnTracker,
  customDbPathGetter?: (sessionId: string) => string,
): void {
  const { sessionId, update } = params;
  if (!sessionId || !update) return;

  const su = update.sessionUpdate;
  if (su === SESSION_UPDATES.TOOL_CALL || su === SESSION_UPDATES.TOOL_CALL_UPDATE) {
    handleToolUpdate(update, sessionId, tracker);
  } else {
    handleNonToolUpdate(update, sessionId, tracker);
  }

  const rawUpdate = update as { stopReason?: unknown };
  if (typeof rawUpdate.stopReason === "string") {
    const customDbPath = customDbPathGetter ? customDbPathGetter(sessionId) : undefined;
    tracker.finishTurn(sessionId, { stopReason: rawUpdate.stopReason, customDbPath });
  }
}

function handleConfigChange(
  msg: JsonRpcRequest,
  sessionId: string,
  tracker: SessionTurnTracker,
): void {
  if (msg.method === ACP_METHODS.SESSION_SET_MODEL) {
    const params = msg.params as { modelId?: string } | undefined;
    if (params?.modelId) tracker.setModel(sessionId, params.modelId);
  } else if (msg.method === ACP_METHODS.SESSION_SET_CONFIG_OPTION) {
    const params = msg.params as { configId?: string; value?: unknown } | undefined;
    if (params?.configId === "model" && typeof params.value === "string") {
      tracker.setModel(sessionId, params.value);
    }
  }
}

function handleOutbound(
  msg: JsonRpcRequest,
  tracker: SessionTurnTracker,
  pendingPromptSessions: Map<string | number, string>,
): void {
  const sessionId = extractSessionId(msg);
  if (!sessionId) return;

  if (msg.method === ACP_METHODS.SESSION_PROMPT) {
    pendingPromptSessions.set(msg.id, sessionId);
    const params = msg.params as SessionPromptParams | undefined;
    if (params?.prompt !== undefined) {
      tracker.startTurn(sessionId, msg.id, params.prompt);
    }
  } else if (msg.method === ACP_METHODS.SESSION_CANCEL) {
    tracker.finishTurn(sessionId, { stopReason: "cancelled", isError: true });
  } else {
    handleConfigChange(msg, sessionId, tracker);
  }
}

function handleModelDiscovery(
  msg: JsonRpcValidResponse,
  sessionId: string | undefined,
  tracker: SessionTurnTracker,
): void {
  if (!sessionId || !isJsonRpcSuccessResponse(msg)) return;
  const res =
    msg.result && typeof msg.result === "object"
      ? (msg.result as { models?: { currentModelId?: string } })
      : {};
  if (res.models?.currentModelId) tracker.setModel(sessionId, res.models.currentModelId);
}

function handleResponse(
  msg: JsonRpcValidResponse,
  context: InboundContext,
  tracker: SessionTurnTracker,
  pendingPromptSessions: Map<string | number, string>,
  customDbPathGetter?: (sessionId: string) => string,
): void {
  const pendingSessionId = pendingPromptSessions.get(msg.id);
  if (pendingSessionId) {
    pendingPromptSessions.delete(msg.id);
    const dbPath = customDbPathGetter ? customDbPathGetter(pendingSessionId) : undefined;
    handlePromptResponse(msg, pendingSessionId, tracker, dbPath);
    return;
  }

  const fallbackSessionId = context.session?.sessionId ?? extractSessionId(msg);
  handleModelDiscovery(msg, fallbackSessionId, tracker);
}

export function createTelemetryFix(options?: {
  config?: OtelConfig;
  exporter?: IOtelExporter;
  customDbPathGetter?: (sessionId: string) => string;
}): AcpFix & { tracker: SessionTurnTracker; exporter: IOtelExporter; config: OtelConfig } {
  const config = options?.config ?? getOtelConfig();
  const exporter = options?.exporter ?? new OtlpExporter(config);
  const tracker = new SessionTurnTracker(config, exporter);
  const pendingPromptSessions = new Map<string | number, string>();

  return {
    name: "opentelemetry",
    description:
      "Exports ACP session prompts, agent responses, tool calls, and model metrics over OpenTelemetry OTLP",
    tracker,
    exporter,
    config,

    onOutbound: (msg: AcpStreamMessage, _context: OutboundContext): AcpStreamMessage => {
      if (!config.enabled || !isJsonRpcRequest(msg)) return msg;
      if (!String(msg.id).startsWith("__refined_agy_recycle_")) {
        handleOutbound(msg, tracker, pendingPromptSessions);
      }
      return msg;
    },

    onInbound: async (
      msg: AcpStreamMessage,
      context: InboundContext,
    ): Promise<AcpStreamMessage[]> => {
      if (!config.enabled || context.isRecycling) return [msg];

      if (isJsonRpcResponse(msg)) {
        handleResponse(msg, context, tracker, pendingPromptSessions, options?.customDbPathGetter);
      } else if ("method" in msg && msg.method === ACP_METHODS.SESSION_UPDATE && msg.params) {
        handleUpdate(msg.params as SessionUpdateParams, tracker, options?.customDbPathGetter);
      }

      return [msg];
    },

    onRecycle: (): void => {},

    dispose: (): void => {
      pendingPromptSessions.clear();
      void exporter.shutdown();
    },
  };
}

export const telemetryFix = createTelemetryFix();
