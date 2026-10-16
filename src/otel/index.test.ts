import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createTelemetryFix,
  getOtelConfig,
  truncateUtf8,
  type ExportLogsServiceRequest,
  type ExportTraceServiceRequest,
  type OtelLogRecord,
  type OtelSpan,
} from "./index.js";
import { ACP_METHODS, SESSION_UPDATES, type AcpStreamMessage } from "../core/types.js";
import { createMockContext } from "../test-utils/e2e-harness.js";

interface FakeCollector {
  server: http.Server;
  port: number;
  traces: OtelSpan[];
  logs: OtelLogRecord[];
  requestCount: number;
  shouldFail: boolean;
  close: () => Promise<void>;
}

async function createFakeCollector(): Promise<FakeCollector> {
  const traces: OtelSpan[] = [];
  const logs: OtelLogRecord[] = [];
  let requestCount = 0;
  let shouldFail = false;

  const server = http.createServer((req, res) => {
    requestCount++;
    if (shouldFail) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "collector failure" }));
      return;
    }

    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf-8");
    });

    req.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        if (req.url?.includes("/v1/traces")) {
          const body = parsed as ExportTraceServiceRequest;
          for (const rs of body.resourceSpans) {
            for (const ss of rs.scopeSpans) {
              traces.push(...ss.spans);
            }
          }
        } else if (req.url?.includes("/v1/logs")) {
          const body = parsed as ExportLogsServiceRequest;
          for (const rl of body.resourceLogs) {
            for (const sl of rl.scopeLogs) {
              logs.push(...sl.logRecords);
            }
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    traces,
    logs,
    get requestCount() {
      return requestCount;
    },
    get shouldFail() {
      return shouldFail;
    },
    set shouldFail(val: boolean) {
      shouldFail = val;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("OpenTelemetry Telemetry Unit Tests", () => {
  let collector: FakeCollector | undefined;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.OTEL_LOG_USER_PROMPTS;
    delete process.env.OTEL_LOG_ASSISTANT_RESPONSES;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (collector) {
      await collector.close();
      collector = undefined;
    }
  });

  it("export disabled: does not export or invoke HTTP endpoints when env vars are absent", async () => {
    collector = await createFakeCollector();
    const config = getOtelConfig({
      // No endpoint configured
    });
    expect(config.enabled).toBe(false);

    const fix = createTelemetryFix({ config });
    const context = createMockContext();

    // Outbound prompt
    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 101,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "s-1", prompt: "Hello world" },
    };
    fix.onOutbound?.(promptMsg, context);

    // Inbound response
    const resMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 101,
      result: { stopReason: "end_turn" },
    };
    await fix.onInbound?.(resMsg, context);
    await fix.exporter.flush();

    expect(collector.traces).toHaveLength(0);
    expect(collector.logs).toHaveLength(0);
  });

  it("content redacted vs included: verifies prompt and response redaction flags", async () => {
    collector = await createFakeCollector();
    const endpoint = `http://127.0.0.1:${collector.port}`;

    // Test 1: Content redacted (default behavior without OTEL_LOG_*=1)
    const configRedacted = getOtelConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    });
    expect(configRedacted.enabled).toBe(true);
    expect(configRedacted.logUserPrompts).toBe(false);
    expect(configRedacted.logAssistantResponses).toBe(false);

    const fixRedacted = createTelemetryFix({ config: configRedacted });
    const context = createMockContext();

    fixRedacted.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 101,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-redacted", prompt: "Super secret prompt" },
      },
      context,
    );

    // Inbound response chunk
    await fixRedacted.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-redacted",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: { text: "Secret model answer" },
          },
        },
      },
      context,
    );

    await fixRedacted.onInbound?.(
      {
        jsonrpc: "2.0",
        id: 101,
        result: { stopReason: "end_turn" },
      },
      context,
    );
    await fixRedacted.exporter.flush();

    const userPromptLog = collector.logs.find(
      (l) => l.body && "stringValue" in l.body && l.body.stringValue === "agy.user_prompt",
    );
    const agentResponseLog = collector.logs.find(
      (l) => l.body && "stringValue" in l.body && l.body.stringValue === "agy.agent_response",
    );

    expect(userPromptLog).toBeDefined();
    expect(agentResponseLog).toBeDefined();

    // Content should NOT be present, but lengths should be present
    const promptAttr = userPromptLog?.attributes.find((a) => a.key === "prompt");
    const promptLenAttr = userPromptLog?.attributes.find((a) => a.key === "prompt_length");
    expect(promptAttr).toBeUndefined();
    expect(promptLenAttr?.value).toEqual({ intValue: "Super secret prompt".length });

    const responseAttr = agentResponseLog?.attributes.find((a) => a.key === "response");
    const responseLenAttr = agentResponseLog?.attributes.find((a) => a.key === "response_length");
    expect(responseAttr).toBeUndefined();
    expect(responseLenAttr?.value).toEqual({ intValue: "Secret model answer".length });

    // Test 2: Content included with OTEL_LOG_USER_PROMPTS=1 and OTEL_LOG_ASSISTANT_RESPONSES=1
    collector.logs.length = 0;
    collector.traces.length = 0;

    const configIncluded = getOtelConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_LOG_USER_PROMPTS: "1",
      OTEL_LOG_ASSISTANT_RESPONSES: "1",
    });
    expect(configIncluded.logUserPrompts).toBe(true);
    expect(configIncluded.logAssistantResponses).toBe(true);

    const fixIncluded = createTelemetryFix({ config: configIncluded });

    fixIncluded.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 201,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-included", prompt: "Visible user prompt" },
      },
      context,
    );

    await fixIncluded.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-included",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: { text: "Visible assistant response" },
          },
        },
      },
      context,
    );

    await fixIncluded.onInbound?.(
      {
        jsonrpc: "2.0",
        id: 201,
        result: { stopReason: "end_turn" },
      },
      context,
    );
    await fixIncluded.exporter.flush();

    const userPromptLogInc = collector.logs.find(
      (l) => l.body && "stringValue" in l.body && l.body.stringValue === "agy.user_prompt",
    );
    const agentResponseLogInc = collector.logs.find(
      (l) => l.body && "stringValue" in l.body && l.body.stringValue === "agy.agent_response",
    );

    const promptAttrInc = userPromptLogInc?.attributes.find((a) => a.key === "prompt");
    expect(promptAttrInc?.value).toEqual({ stringValue: "Visible user prompt" });

    const responseAttrInc = agentResponseLogInc?.attributes.find((a) => a.key === "response");
    expect(responseAttrInc?.value).toEqual({ stringValue: "Visible assistant response" });
  });

  it("truncation: safely truncates text exceeding 64 KiB on UTF-8 boundaries", () => {
    // 3-byte unicode character: '€' (euro sign: 0xE2 0x82 0xAC)
    const euro = "€";
    const chunk = euro.repeat(25000); // 75,000 bytes > 65,536 bytes
    const res = truncateUtf8(chunk);

    expect(res.truncated).toBe(true);
    expect(res.byteLength).toBeLessThanOrEqual(64 * 1024);
    // Verify that the truncated byte length is divisible by 3 (complete euro characters)
    expect(res.byteLength % 3).toBe(0);
    // Verify valid UTF-8 round-trip without corruption or replacement characters
    expect(res.text).not.toContain("\ufffd");
  });

  it("model switch mid-session: updates turn span names and model attributes", async () => {
    collector = await createFakeCollector();
    const endpoint = `http://127.0.0.1:${collector.port}`;
    const config = getOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    const fix = createTelemetryFix({ config });
    const context = createMockContext();

    // Initial turn with default model
    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 301,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-model-switch", prompt: "Turn 1" },
      },
      context,
    );
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        id: 301,
        result: { stopReason: "end_turn" },
      },
      context,
    );
    await fix.exporter.flush();

    expect(collector.traces).toHaveLength(1);
    expect(collector.traces[0]?.name).toBe("chat gemini-3.8-flash");

    // Client switches model via session/set_model
    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 302,
        method: ACP_METHODS.SESSION_SET_MODEL,
        params: { sessionId: "s-model-switch", modelId: "gemini-4-argon" },
      },
      context,
    );

    // Second turn with updated model
    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 303,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-model-switch", prompt: "Turn 2" },
      },
      context,
    );
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        id: 303,
        result: { stopReason: "end_turn" },
      },
      context,
    );
    await fix.exporter.flush();

    expect(collector.traces).toHaveLength(2);
    expect(collector.traces[1]?.name).toBe("chat gemini-4-argon");
    const modelAttr = collector.traces[1]?.attributes.find((a) => a.key === "gen_ai.request.model");
    expect(modelAttr?.value).toEqual({ stringValue: "gemini-4-argon" });
  });

  it("cancelled turn: sets error status and finish_reasons when cancelled", async () => {
    collector = await createFakeCollector();
    const endpoint = `http://127.0.0.1:${collector.port}`;
    const config = getOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    const fix = createTelemetryFix({ config });
    const context = createMockContext();

    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 401,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-cancel", prompt: "Will be cancelled" },
      },
      context,
    );

    // Cancel mid-turn
    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 402,
        method: ACP_METHODS.SESSION_CANCEL,
        params: { sessionId: "s-cancel" },
      },
      context,
    );
    await fix.exporter.flush();

    expect(collector.traces).toHaveLength(1);
    const span = collector.traces[0]!;
    expect(span.status?.code).toBe(2); // STATUS_CODE.ERROR
    const finishReasons = span.attributes.find((a) => a.key === "gen_ai.response.finish_reasons");
    expect(finishReasons?.value).toEqual({
      arrayValue: { values: [{ stringValue: "cancelled" }] },
    });
  });

  it("collector down: drops failed exports in background without affecting ACP stream or stdout", async () => {
    collector = await createFakeCollector();
    collector.shouldFail = true; // Collector returns HTTP 500

    const endpoint = `http://127.0.0.1:${collector.port}`;
    const config = getOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    const fix = createTelemetryFix({ config });
    const context = createMockContext();

    // Stream message handling must never throw or reject
    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 501,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "s-collector-down", prompt: "Hello" },
    };
    const outboundRes = fix.onOutbound?.(promptMsg, context);
    expect(outboundRes).toEqual(promptMsg);

    const inboundMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 501,
      result: { stopReason: "end_turn" },
    };
    const inboundRes = await fix.onInbound?.(inboundMsg, context);
    expect(inboundRes).toEqual([inboundMsg]);

    // Exporter flush should complete without throwing
    await expect(fix.exporter.flush()).resolves.toBeUndefined();
  });

  it("tool call spans: emits execute_tool child spans under turn span", async () => {
    collector = await createFakeCollector();
    const endpoint = `http://127.0.0.1:${collector.port}`;
    const config = getOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    const fix = createTelemetryFix({ config });
    const context = createMockContext();

    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 601,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-tools", prompt: "Run command" },
      },
      context,
    );

    // Inbound tool call notification
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-tools",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: "call-1",
            title: "run_command",
          },
        },
      },
      context,
    );

    // Inbound tool call completed
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-tools",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
            toolCallId: "call-1",
            status: "completed",
          },
        },
      },
      context,
    );

    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        id: 601,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 1500, outputTokens: 250 },
        },
      },
      context,
    );
    await fix.exporter.flush();

    expect(collector.traces).toHaveLength(2);
    const parentSpan = collector.traces.find((s) => s.name.startsWith("chat"));
    const childSpan = collector.traces.find((s) => s.name === "execute_tool run_command");

    expect(parentSpan).toBeDefined();
    expect(childSpan).toBeDefined();
    expect(childSpan?.parentSpanId).toBe(parentSpan?.spanId);
    expect(childSpan?.traceId).toBe(parentSpan?.traceId);

    const inputTokens = parentSpan?.attributes.find((a) => a.key === "gen_ai.usage.input_tokens");
    const outputTokens = parentSpan?.attributes.find((a) => a.key === "gen_ai.usage.output_tokens");
    expect(inputTokens?.value).toEqual({ intValue: 1500 });
    expect(outputTokens?.value).toEqual({ intValue: 250 });
  });

  it("process recycling: suppresses replayed messages during child recycling", async () => {
    collector = await createFakeCollector();
    const endpoint = `http://127.0.0.1:${collector.port}`;
    const config = getOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    const fix = createTelemetryFix({ config });
    const context = createMockContext();

    // Start a normal turn
    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 701,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-recycle", prompt: "Hello" },
      },
      context,
    );

    // Simulate process recycle replaying session/load with isRecycling = true
    const recycleContext = { ...context, isRecycling: true };
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-recycle",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: { text: "Replayed history from previous turn" },
          },
        },
      },
      recycleContext,
    );

    // Live chunk arrives
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-recycle",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: { text: "Live response" },
          },
        },
      },
      context,
    );

    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        id: 701,
        result: { stopReason: "end_turn" },
      },
      context,
    );
    await fix.exporter.flush();

    // Verify response length in log only accounts for live chunk, not replayed history
    const responseLog = collector.logs.find(
      (l) => l.body && "stringValue" in l.body && l.body.stringValue === "agy.agent_response",
    );
    const lenAttr = responseLog?.attributes.find((a) => a.key === "response_length");
    expect(lenAttr?.value).toEqual({ intValue: "Live response".length });
  });

  it("tool span naming: resolves canonical tool name and stores command in attribute without command in span name", async () => {
    collector = await createFakeCollector();
    const endpoint = `http://127.0.0.1:${collector.port}`;
    const config = getOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    const fix = createTelemetryFix({ config });
    const context = createMockContext();

    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 801,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-tool-names", prompt: "Execute tools" },
      },
      context,
    );

    // Tool 1: view_file with title "Running view_file"
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-tool-names",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: "call-view-1",
            name: "view_file",
            title: "Running view_file",
            rawInput: { AbsolutePath: "/path/to/file.txt" },
          },
        },
      },
      context,
    );
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-tool-names",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
            toolCallId: "call-view-1",
            status: "completed",
          },
        },
      },
      context,
    );

    // Tool 2: run_command where title is the full command line
    const cmdLine = 'find /home/coder /tmp/agytest -name "a.txt" 2>/dev/null';
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-tool-names",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: "call-cmd-1",
            name: "run_command",
            title: cmdLine,
            rawInput: { CommandLine: cmdLine },
          },
        },
      },
      context,
    );
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "s-tool-names",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
            toolCallId: "call-cmd-1",
            status: "completed",
          },
        },
      },
      context,
    );

    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        id: 801,
        result: { stopReason: "end_turn" },
      },
      context,
    );
    await fix.exporter.flush();

    const viewSpan = collector.traces.find((s) => s.name === "execute_tool view_file");
    const cmdSpan = collector.traces.find((s) => s.name === "execute_tool run_command");

    expect(viewSpan).toBeDefined();
    expect(cmdSpan).toBeDefined();

    // Verify gen_ai.tool.name is clean tool identifier
    const viewToolName = viewSpan?.attributes.find((a) => a.key === "gen_ai.tool.name");
    const cmdToolName = cmdSpan?.attributes.find((a) => a.key === "gen_ai.tool.name");
    expect(viewToolName?.value).toEqual({ stringValue: "view_file" });
    expect(cmdToolName?.value).toEqual({ stringValue: "run_command" });

    // Verify command line was placed into attribute, NOT the span name
    const cmdAttr = cmdSpan?.attributes.find((a) => a.key === "tool.command");
    expect(cmdAttr?.value).toEqual({ stringValue: cmdLine });
    expect(collector.traces.some((s) => s.name.includes("find /home"))).toBe(false);
  });

  it("logged prompt: strips wrapper-injected <system_instruction> blocks from user prompt log", async () => {
    collector = await createFakeCollector();
    const endpoint = `http://127.0.0.1:${collector.port}`;
    const config = getOtelConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_LOG_USER_PROMPTS: "1",
    });
    const fix = createTelemetryFix({ config });
    const context = createMockContext();

    const injectedPrompt = [
      {
        type: "text",
        text: "<system_instruction>\n- Keep responses concise.\n- Always explain rationale.\n</system_instruction>\n\n<user_instruction>\nCustom persona\n</user_instruction>\n\nWhat is the status?",
      },
    ];

    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 901,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-strip-sys", prompt: injectedPrompt },
      },
      context,
    );

    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        id: 901,
        result: { stopReason: "end_turn" },
      },
      context,
    );
    await fix.exporter.flush();

    const promptLog = collector.logs.find(
      (l) => l.body && "stringValue" in l.body && l.body.stringValue === "agy.user_prompt",
    );
    expect(promptLog).toBeDefined();

    const promptText = promptLog?.attributes.find((a) => a.key === "prompt");
    expect((promptText?.value as { stringValue?: string })?.stringValue).toBe(
      "What is the status?",
    );
  });

  it("cache read tokens: exports gen_ai.usage.cache_read.input_tokens when cached tokens are present", async () => {
    collector = await createFakeCollector();
    const endpoint = `http://127.0.0.1:${collector.port}`;
    const config = getOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    const fix = createTelemetryFix({ config });
    const context = createMockContext();

    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 902,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId: "s-cache-tokens", prompt: "Hello cache" },
      },
      context,
    );

    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        id: 902,
        result: {
          stopReason: "end_turn",
          usage: {
            inputTokens: 140000,
            outputTokens: 350,
            cachedTokens: 135000,
          },
        },
      },
      context,
    );
    await fix.exporter.flush();

    const turnSpan = collector.traces.find((s) => s.name.startsWith("chat"));
    expect(turnSpan).toBeDefined();

    const inputTokens = turnSpan?.attributes.find((a) => a.key === "gen_ai.usage.input_tokens");
    const outputTokens = turnSpan?.attributes.find((a) => a.key === "gen_ai.usage.output_tokens");
    const cacheTokens = turnSpan?.attributes.find(
      (a) => a.key === "gen_ai.usage.cache_read.input_tokens",
    );

    expect(inputTokens?.value).toEqual({ intValue: 140000 });
    expect(outputTokens?.value).toEqual({ intValue: 350 });
    expect(cacheTokens?.value).toEqual({ intValue: 135000 });
  });
});
