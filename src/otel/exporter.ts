/**
 * Zero-dependency OpenTelemetry OTLP Exporter.
 * Delivers traces and logs in the background over standard OTLP/HTTP.
 * Never writes to stdout. Errors are routed to stderr only behind REFINED_AGY_TRACE=1.
 */

import type { OtelConfig } from "./config.js";
import {
  toOtelKeyValues,
  type ExportLogsServiceRequest,
  type ExportTraceServiceRequest,
  type OtelLogRecord,
  type OtelSpan,
} from "./types.js";

export interface IOtelExporter {
  readonly exportSpans: (spans: OtelSpan[]) => void;
  readonly exportLogs: (logs: OtelLogRecord[]) => void;
  readonly flush: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

export class OtlpExporter implements IOtelExporter {
  private readonly config: OtelConfig;
  private readonly pendingRequests = new Set<Promise<void>>();
  private isShutdown = false;

  constructor(config: OtelConfig) {
    this.config = config;
  }

  exportSpans(spans: OtelSpan[]): void {
    if (
      !this.config.enabled ||
      !this.config.tracesEndpoint ||
      spans.length === 0 ||
      this.isShutdown
    ) {
      return;
    }

    const payload: ExportTraceServiceRequest = {
      resourceSpans: [
        {
          resource: {
            attributes: toOtelKeyValues(this.config.resourceAttributes),
          },
          scopeSpans: [
            {
              scope: {
                name: this.config.serviceName,
              },
              spans,
            },
          ],
        },
      ],
    };

    this.sendPayload(this.config.tracesEndpoint, this.config.tracesHeaders, payload);
  }

  exportLogs(logs: OtelLogRecord[]): void {
    if (!this.config.enabled || !this.config.logsEndpoint || logs.length === 0 || this.isShutdown) {
      return;
    }

    const payload: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          resource: {
            attributes: toOtelKeyValues(this.config.resourceAttributes),
          },
          scopeLogs: [
            {
              scope: {
                name: this.config.serviceName,
              },
              logRecords: logs,
            },
          ],
        },
      ],
    };

    this.sendPayload(this.config.logsEndpoint, this.config.logsHeaders, payload);
  }

  private sendPayload(url: string, headers: Record<string, string>, payload: unknown): void {
    const requestPromise = (async () => {
      try {
        const body = JSON.stringify(payload);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body,
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok && process.env.REFINED_AGY_TRACE === "1") {
          process.stderr.write(
            `[refined-antigravity-acp] OTLP exporter received HTTP ${res.status} from ${url}\n`,
          );
        }
      } catch (err) {
        if (process.env.REFINED_AGY_TRACE === "1") {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[refined-antigravity-acp] OTLP exporter failed to send to ${url}: ${msg}\n`,
          );
        }
      }
    })();

    this.pendingRequests.add(requestPromise);
    void requestPromise.finally(() => {
      this.pendingRequests.delete(requestPromise);
    });
  }

  async flush(): Promise<void> {
    while (this.pendingRequests.size > 0) {
      await Promise.all(Array.from(this.pendingRequests));
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await this.flush();
  }
}
