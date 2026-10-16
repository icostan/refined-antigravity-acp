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

function extractCommandFromRaw(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const raw = rawInput as Record<string, unknown>;
  if (typeof raw.CommandLine === "string") return raw.CommandLine;
  if (typeof raw.command === "string") return raw.command;
  return undefined;
}

function inferToolFromRaw(rawInput: unknown): string {
  if (rawInput && typeof rawInput === "object") {
    const raw = rawInput as Record<string, unknown>;
    if ("CommandLine" in raw) return "run_command";
    if ("AbsolutePath" in raw || "TargetFile" in raw || "targetFile" in raw) return "view_file";
  }
  return "run_command";
}

function cleanToolName(name?: string | null): string | undefined {
  if (typeof name !== "string") return undefined;
  const trimmed = name.replace(/^Running:?\s+/i, "").trim();
  return trimmed || undefined;
}

function inferFromTitle(title: string, rawInput: unknown): { toolName: string; command?: string } {
  const cleaned = cleanToolName(title);
  if (cleaned && /^[a-zA-Z0-9_-]+$/.test(cleaned)) {
    return { toolName: cleaned };
  }
  return {
    toolName: inferToolFromRaw(rawInput),
    command: title,
  };
}

function resolveCommand(
  title: string | undefined,
  toolName: string,
  existingCommand?: string,
): string | undefined {
  if (existingCommand || !title) return existingCommand;
  if (title === toolName || title === `Running ${toolName}`) return undefined;
  return title;
}

export function resolveToolName(update: {
  name?: string | null | undefined;
  tool?: string | null | undefined;
  title?: string | null | undefined;
  rawInput?: unknown;
}): { toolName: string; command?: string | undefined } {
  let command = extractCommandFromRaw(update.rawInput);
  let toolName = cleanToolName(update.name) ?? cleanToolName(update.tool);
  const title = typeof update.title === "string" ? update.title.trim() : undefined;

  if (!toolName && title) {
    const inferred = inferFromTitle(title, update.rawInput);
    toolName = inferred.toolName;
    command ??= inferred.command;
  }

  const finalToolName = toolName || "tool";
  return {
    toolName: finalToolName,
    command: resolveCommand(title, finalToolName, command),
  };
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
    rawInput?: unknown;
    arguments?: unknown;
    status?: string;
  };
  const callId = call.toolCallId || call.callId || call.id;
  if (!callId) return;

  if (update.sessionUpdate === SESSION_UPDATES.TOOL_CALL) {
    const { toolName, command } = resolveToolName({
      name: call.name,
      tool: call.tool,
      title: call.title,
      rawInput: call.rawInput ?? call.arguments,
    });
    tracker.recordToolCall(sessionId, callId, toolName, command);
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
