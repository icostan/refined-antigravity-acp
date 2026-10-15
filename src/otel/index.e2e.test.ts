import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawnWrapped, type AcpTestClient } from "../test-utils/index.js";
import type {
  ExportLogsServiceRequest,
  ExportTraceServiceRequest,
  OtelLogRecord,
  OtelSpan,
} from "./index.js";

interface LocalOtlpReceiver {
  server: http.Server;
  endpoint: string;
  traces: OtelSpan[];
  logs: OtelLogRecord[];
  close: () => Promise<void>;
}

async function startLocalOtlpReceiver(): Promise<LocalOtlpReceiver> {
  const traces: OtelSpan[] = [];
  const logs: OtelLogRecord[] = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf-8");
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        if (req.url?.includes("/v1/traces")) {
          const body = parsed as ExportTraceServiceRequest;
          for (const rs of body.resourceSpans || []) {
            for (const ss of rs.scopeSpans || []) {
              traces.push(...(ss.spans || []));
            }
          }
        } else if (req.url?.includes("/v1/logs")) {
          const body = parsed as ExportLogsServiceRequest;
          for (const rl of body.resourceLogs || []) {
            for (const sl of rl.scopeLogs || []) {
              logs.push(...(sl.logRecords || []));
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
  const endpoint = `http://127.0.0.1:${port}`;

  return {
    server,
    endpoint,
    traces,
    logs,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("OpenTelemetry E2E Integration", () => {
  const activeClients: AcpTestClient[] = [];
  let receiver: LocalOtlpReceiver | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (activeClients.length > 0) {
      const c = activeClients.pop();
      await c?.close().catch(() => {});
    }
    if (receiver) {
      await receiver.close();
      receiver = undefined;
    }
  });

  it("solution: runs one prompt through wrapped server and reports span and log events to local OTLP receiver", async () => {
    receiver = await startLocalOtlpReceiver();

    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", receiver.endpoint);
    vi.stubEnv("OTEL_LOG_USER_PROMPTS", "1");
    vi.stubEnv("OTEL_LOG_ASSISTANT_RESPONSES", "1");
    vi.stubEnv("OTEL_SERVICE_NAME", "e2e-refined-antigravity");

    const client = await spawnWrapped();
    activeClients.push(client);

    await client.initialize();
    const { sessionId } = await client.newSession();
    const promptRes = await client.prompt(sessionId, "Echo hello world");
    await client.waitForResponse(promptRes.id, 90000);

    // Give background export a moment to deliver to local receiver
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (receiver.traces.length === 0 || receiver.logs.length < 2)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Verify trace spans
    expect(receiver.traces.length).toBeGreaterThanOrEqual(1);
    const turnSpan = receiver.traces.find((s) => s.name.startsWith("chat"));
    expect(turnSpan).toBeDefined();

    const convId = turnSpan?.attributes.find((a) => a.key === "gen_ai.conversation.id");
    expect(convId?.value).toEqual({ stringValue: sessionId });

    const opName = turnSpan?.attributes.find((a) => a.key === "gen_ai.operation.name");
    expect(opName?.value).toEqual({ stringValue: "chat" });

    // Verify log events
    expect(receiver.logs.length).toBeGreaterThanOrEqual(2);
    const promptLog = receiver.logs.find(
      (l) => l.body && "stringValue" in l.body && l.body.stringValue === "agy.user_prompt",
    );
    const responseLog = receiver.logs.find(
      (l) => l.body && "stringValue" in l.body && l.body.stringValue === "agy.agent_response",
    );

    expect(promptLog).toBeDefined();
    expect(responseLog).toBeDefined();

    const promptTextAttr = promptLog?.attributes.find((a) => a.key === "prompt");
    expect((promptTextAttr?.value as { stringValue?: string })?.stringValue).toContain(
      "Echo hello world",
    );

    const responseLenAttr = responseLog?.attributes.find((a) => a.key === "response_length");
    expect(responseLenAttr).toBeDefined();
  }, 120000);
});
