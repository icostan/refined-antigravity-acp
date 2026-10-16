/**
 * Session turn and telemetry tracker.
 * Maps ACP session prompts, response streams, and tool executions to OpenTelemetry
 * GenAI semantic conventions and Antigravity CLI log events.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { OtelConfig } from "./config.js";
import type { IOtelExporter } from "./exporter.js";
import { truncateUtf8 } from "./utf8.js";
import {
  SPAN_KIND,
  STATUS_CODE,
  toOtelKeyValues,
  type OtelLogRecord,
  type OtelSpan,
} from "./types.js";
import type { PromptContentItem } from "../core/types.js";
import type { TokenUsage } from "../fixes/missing-usage-metrics/index.js";
import { getLatestSessionUsage } from "../fixes/missing-usage-metrics/index.js";
import { stripSystemContext } from "../fixes/missing-system-prompt/index.js";
import { getConversationDbPath } from "../fixes/orphaned-checkpoints/index.js";
import { getField, getVarintField } from "../lib/protobuf.js";

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function nowUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export interface InFlightToolCall {
  toolCallId: string;
  toolName: string;
  command?: string | undefined;
  spanId: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  status: "in_progress" | "completed" | "failed";
}

export interface InFlightTurn {
  promptRequestId: string | number;
  sessionId: string;
  model: string;
  traceId: string;
  spanId: string;
  startTimeUnixNano: string;
  rawPromptText: string;
  responseChunks: string[];
  toolCalls: Map<string, InFlightToolCall>;
  orderedCompletedTools: OtelSpan[];
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  stopReason?: string;
  isError?: boolean;
  errorMessage?: string;
}

function parseVarintsFromField9(f9: Uint8Array): {
  promptTokens?: number | undefined;
  candidateTokens?: number | undefined;
  cachedTokens?: number | undefined;
} {
  const promptTokens = getVarintField(f9, 2);
  const candidateTokens = getVarintField(f9, 3);
  const cachedTokens = getVarintField(f9, 5);
  return {
    promptTokens: typeof promptTokens === "number" ? promptTokens : undefined,
    candidateTokens: typeof candidateTokens === "number" ? candidateTokens : undefined,
    cachedTokens: typeof cachedTokens === "number" && cachedTokens > 0 ? cachedTokens : undefined,
  };
}

export function readTokensFromDb(dbPath: string):
  | {
      promptTokens?: number | undefined;
      candidateTokens?: number | undefined;
      cachedTokens?: number | undefined;
    }
  | undefined {
  if (!existsSync(dbPath)) return undefined;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { timeout: 1000, readOnly: true });
    const row = db
      .prepare(
        "SELECT metadata FROM steps WHERE step_type IN (15, 2) AND metadata IS NOT NULL ORDER BY idx DESC LIMIT 1;",
      )
      .get() as { metadata: Uint8Array | null } | undefined;
    if (!row?.metadata) return undefined;
    const f9 = getField(row.metadata, 9);
    return f9 ? parseVarintsFromField9(f9) : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function applyTokensToTurn(
  turn: InFlightTurn,
  tokens?:
    | {
        promptTokens?: number | undefined;
        candidateTokens?: number | undefined;
        cachedTokens?: number | undefined;
      }
    | undefined,
): void {
  if (!tokens) return;
  if (turn.cachedInputTokens === undefined && tokens.cachedTokens !== undefined) {
    turn.cachedInputTokens = tokens.cachedTokens;
  }
  if (turn.outputTokens === undefined && tokens.candidateTokens !== undefined) {
    turn.outputTokens = tokens.candidateTokens;
  }
  if (tokens.promptTokens !== undefined) {
    const totalInput = tokens.promptTokens + (tokens.cachedTokens ?? 0);
    if (turn.inputTokens === undefined || turn.inputTokens < totalInput) {
      turn.inputTokens = totalInput;
    }
  }
}

function buildToolSpan(
  turn: InFlightTurn,
  tool: InFlightToolCall,
  endTimeUnixNano: string,
  isError: boolean,
  errorMessage?: string,
): OtelSpan {
  const toolAttrs: Record<string, unknown> = {
    "gen_ai.tool.name": tool.toolName,
    "gen_ai.tool.call.id": tool.toolCallId,
  };
  if (tool.command && tool.command !== tool.toolName) {
    toolAttrs["tool.command"] = tool.command;
  }

  return {
    traceId: turn.traceId,
    spanId: tool.spanId,
    parentSpanId: turn.spanId,
    name: `execute_tool ${tool.toolName}`,
    kind: SPAN_KIND.INTERNAL,
    startTimeUnixNano: tool.startTimeUnixNano,
    endTimeUnixNano,
    attributes: toOtelKeyValues(toolAttrs),
    status: {
      code: isError ? STATUS_CODE.ERROR : STATUS_CODE.OK,
      ...(isError && errorMessage ? { message: errorMessage } : {}),
    },
  };
}

function closeRemainingTools(turn: InFlightTurn, endTimeUnixNano: string, isError: boolean): void {
  for (const tool of turn.toolCalls.values()) {
    turn.orderedCompletedTools.push(buildToolSpan(turn, tool, endTimeUnixNano, isError));
  }
  turn.toolCalls.clear();
}

function determineTurnStatus(options?: {
  stopReason?: string | undefined;
  isError?: boolean | undefined;
}): {
  stopReason: string;
  isError: boolean;
} {
  const isErr = Boolean(options?.isError || options?.stopReason === "cancelled");
  const stopReason = options?.stopReason ?? (isErr ? "error" : "end_turn");
  return { stopReason, isError: isErr };
}

function buildTurnSpan(
  turn: InFlightTurn,
  endTimeUnixNano: string,
  stopReason: string,
  isError: boolean,
  errorMessage?: string,
): OtelSpan {
  const spanAttributes: Record<string, unknown> = {
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": turn.model,
    "gen_ai.provider.name": "gcp.gemini",
    "gen_ai.conversation.id": turn.sessionId,
    "gen_ai.response.finish_reasons": [stopReason],
  };

  if (turn.inputTokens !== undefined) {
    spanAttributes["gen_ai.usage.input_tokens"] = turn.inputTokens;
  }
  if (turn.outputTokens !== undefined) {
    spanAttributes["gen_ai.usage.output_tokens"] = turn.outputTokens;
  }
  if (turn.cachedInputTokens !== undefined) {
    spanAttributes["gen_ai.usage.cache_read.input_tokens"] = turn.cachedInputTokens;
  }

  return {
    traceId: turn.traceId,
    spanId: turn.spanId,
    name: `chat ${turn.model}`,
    kind: SPAN_KIND.CLIENT,
    startTimeUnixNano: turn.startTimeUnixNano,
    endTimeUnixNano,
    attributes: toOtelKeyValues(spanAttributes),
    status: {
      code: isError ? STATUS_CODE.ERROR : STATUS_CODE.OK,
      ...(isError ? { message: errorMessage || stopReason } : {}),
    },
  };
}

export class SessionTurnTracker {
  private readonly config: OtelConfig;
  private readonly exporter: IOtelExporter;
  private readonly sessionModels = new Map<string, string>();
  private readonly activeTurnsBySession = new Map<string, InFlightTurn>();
  private readonly activeTurnsByPromptId = new Map<string | number, InFlightTurn>();

  constructor(config: OtelConfig, exporter: IOtelExporter) {
    this.config = config;
    this.exporter = exporter;
  }

  getModel(sessionId: string): string {
    return this.sessionModels.get(sessionId) || "gemini-3.8-flash";
  }

  setModel(sessionId: string, model: string): void {
    if (model && typeof model === "string") {
      this.sessionModels.set(sessionId, model);
    }
  }

  formatPromptText(prompt: string | PromptContentItem[]): string {
    const rawText =
      typeof prompt === "string"
        ? prompt
        : Array.isArray(prompt)
          ? prompt
              .map((item) => {
                if (!item || typeof item !== "object") return "";
                if (item.type === "text" && typeof item.text === "string") {
                  return item.text;
                }
                return `[${item.type || "content"}]`;
              })
              .filter(Boolean)
              .join("\n")
          : String(prompt ?? "");

    return stripSystemContext(rawText).trim();
  }

  startTurn(
    sessionId: string,
    promptRequestId: string | number,
    rawPrompt: string | PromptContentItem[],
  ): InFlightTurn {
    const model = this.getModel(sessionId);
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const startTimeUnixNano = nowUnixNano();
    const rawPromptText = this.formatPromptText(rawPrompt);

    const turn: InFlightTurn = {
      promptRequestId,
      sessionId,
      model,
      traceId,
      spanId,
      startTimeUnixNano,
      rawPromptText,
      responseChunks: [],
      toolCalls: new Map(),
      orderedCompletedTools: [],
    };

    this.activeTurnsBySession.set(sessionId, turn);
    this.activeTurnsByPromptId.set(promptRequestId, turn);

    this.emitUserPromptLog(turn);
    return turn;
  }

  private emitUserPromptLog(turn: InFlightTurn): void {
    const rawLen = turn.rawPromptText.length;
    const { text: truncatedPrompt } = truncateUtf8(turn.rawPromptText);

    const attributes: Record<string, unknown> = {
      "event.name": "agy.user_prompt",
      prompt_length: rawLen,
      "gen_ai.conversation.id": turn.sessionId,
      "gen_ai.request.model": turn.model,
      "gen_ai.provider.name": "gcp.gemini",
    };

    if (this.config.logUserPrompts) {
      attributes.prompt = truncatedPrompt;
    }

    const logRecord: OtelLogRecord = {
      timeUnixNano: turn.startTimeUnixNano,
      observedTimeUnixNano: turn.startTimeUnixNano,
      severityNumber: 9,
      severityText: "INFO",
      body: { stringValue: "agy.user_prompt" },
      attributes: toOtelKeyValues(attributes),
      traceId: turn.traceId,
      spanId: turn.spanId,
    };

    this.exporter.exportLogs([logRecord]);
  }

  appendResponseChunk(sessionId: string, text: string): void {
    const turn = this.activeTurnsBySession.get(sessionId);
    if (!turn) return;
    turn.responseChunks.push(text);
  }

  recordToolCall(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    command?: string | undefined,
  ): void {
    const turn = this.activeTurnsBySession.get(sessionId);
    if (!turn) return;

    if (!turn.toolCalls.has(toolCallId)) {
      turn.toolCalls.set(toolCallId, {
        toolCallId,
        toolName: toolName || "tool",
        command,
        spanId: generateSpanId(),
        startTimeUnixNano: nowUnixNano(),
        status: "in_progress",
      });
    }
  }

  updateToolCall(
    sessionId: string,
    toolCallId: string,
    status: "completed" | "failed" | string,
  ): void {
    const turn = this.activeTurnsBySession.get(sessionId);
    if (!turn) return;

    const tool = turn.toolCalls.get(toolCallId);
    if (!tool) return;

    const endNano = nowUnixNano();
    tool.endTimeUnixNano = endNano;

    const isFailure = status === "failed";
    tool.status = isFailure ? "failed" : "completed";

    turn.orderedCompletedTools.push(
      buildToolSpan(turn, tool, endNano, isFailure, isFailure ? "tool call failed" : undefined),
    );
    turn.toolCalls.delete(toolCallId);
  }

  recordUsageUpdate(sessionId: string, used: number, _size?: number): void {
    const turn = this.activeTurnsBySession.get(sessionId);
    if (!turn) return;
    if (typeof used === "number" && turn.inputTokens === undefined) {
      turn.inputTokens = used;
    }
  }

  recordExplicitUsage(
    sessionId: string,
    usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number },
  ): void {
    const turn = this.activeTurnsBySession.get(sessionId);
    if (!turn) return;
    if (typeof usage.inputTokens === "number") turn.inputTokens = usage.inputTokens;
    if (typeof usage.outputTokens === "number") turn.outputTokens = usage.outputTokens;
    if (typeof usage.cachedTokens === "number") turn.cachedInputTokens = usage.cachedTokens;
  }

  private reconcileTokens(turn: InFlightTurn, sessionId: string, customDbPath?: string): void {
    if (
      turn.inputTokens !== undefined &&
      turn.outputTokens !== undefined &&
      turn.cachedInputTokens !== undefined
    ) {
      return;
    }

    const dbPath = customDbPath ?? getConversationDbPath(sessionId);
    applyTokensToTurn(turn, readTokensFromDb(dbPath));
    if (
      turn.inputTokens === undefined ||
      turn.outputTokens === undefined ||
      turn.cachedInputTokens === undefined
    ) {
      applyTokensToTurn(turn, this.extractDatabaseUsage(sessionId, customDbPath) ?? undefined);
    }
  }

  private resolveActiveTurn(
    sessionId: string,
    promptRequestId?: string | number,
  ): InFlightTurn | undefined {
    if (promptRequestId !== undefined) {
      const turn = this.activeTurnsByPromptId.get(promptRequestId);
      if (turn) return turn;
    }
    return this.activeTurnsBySession.get(sessionId);
  }

  finishTurn(
    sessionId: string,
    options?: {
      promptRequestId?: string | number | undefined;
      stopReason?: string | undefined;
      isError?: boolean | undefined;
      errorMessage?: string | undefined;
      customDbPath?: string | undefined;
    },
  ): void {
    const turn = this.resolveActiveTurn(sessionId, options?.promptRequestId);
    if (!turn) return;

    this.activeTurnsBySession.delete(sessionId);
    this.activeTurnsByPromptId.delete(turn.promptRequestId);

    const endTimeUnixNano = nowUnixNano();
    const { stopReason, isError } = determineTurnStatus(options);

    closeRemainingTools(turn, endTimeUnixNano, isError);
    this.reconcileTokens(turn, sessionId, options?.customDbPath);

    this.emitAgentResponseLog(turn, endTimeUnixNano);

    const turnSpan = buildTurnSpan(
      turn,
      endTimeUnixNano,
      stopReason,
      isError,
      options?.errorMessage,
    );

    this.exporter.exportSpans([turnSpan, ...turn.orderedCompletedTools]);
  }

  private emitAgentResponseLog(turn: InFlightTurn, timeUnixNano: string): void {
    const rawResponse = turn.responseChunks.join("");
    const rawLen = rawResponse.length;
    const { text: truncatedResponse, truncated } = truncateUtf8(rawResponse);

    const attributes: Record<string, unknown> = {
      "event.name": "agy.agent_response",
      response_length: rawLen,
      response_truncated: truncated,
      "gen_ai.conversation.id": turn.sessionId,
      "gen_ai.request.model": turn.model,
      "gen_ai.provider.name": "gcp.gemini",
    };

    if (this.config.logAssistantResponses) {
      attributes.response = truncatedResponse;
    }

    const logRecord: OtelLogRecord = {
      timeUnixNano,
      observedTimeUnixNano: timeUnixNano,
      severityNumber: 9,
      severityText: "INFO",
      body: { stringValue: "agy.agent_response" },
      attributes: toOtelKeyValues(attributes),
      traceId: turn.traceId,
      spanId: turn.spanId,
    };

    this.exporter.exportLogs([logRecord]);
  }

  private extractDatabaseUsage(
    sessionId: string,
    customDbPath?: string,
  ): (TokenUsage & { cachedTokens?: number | undefined }) | null {
    try {
      const usage = getLatestSessionUsage(sessionId, customDbPath);
      if (!usage) return null;
      if (usage.cachedTokens !== undefined) return usage;
      const dbPath = customDbPath ?? getConversationDbPath(sessionId);
      const dbTokens = readTokensFromDb(dbPath);
      return {
        ...usage,
        ...(dbTokens?.cachedTokens !== undefined ? { cachedTokens: dbTokens.cachedTokens } : {}),
      };
    } catch {
      return null;
    }
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurnsBySession.has(sessionId);
  }
}
