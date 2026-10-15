/**
 * OpenTelemetry OTLP JSON data types and builder helpers.
 * Conforms to OpenTelemetry v1 Resource, Span, and Log Record schemas.
 */

export type OtelAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string | number }
  | { doubleValue: number }
  | { arrayValue: { values: OtelAnyValue[] } }
  | { kvlistValue: { values: OtelKeyValue[] } };

export interface OtelKeyValue {
  key: string;
  value: OtelAnyValue;
}

export function toOtelValue(value: unknown): OtelAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { intValue: value };
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toOtelValue) } };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => ({
      key: k,
      value: toOtelValue(v),
    }));
    return { kvlistValue: { values: entries } };
  }
  return { stringValue: String(value ?? "") };
}

export function toOtelKeyValues(record: Record<string, unknown>): OtelKeyValue[] {
  const result: OtelKeyValue[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result.push({ key, value: toOtelValue(value) });
    }
  }
  return result;
}

export const SPAN_KIND = {
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

export const STATUS_CODE = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtelKeyValue[];
  status?: {
    code: number;
    message?: string;
  };
}

export interface ExportTraceServiceRequest {
  resourceSpans: Array<{
    resource: {
      attributes: OtelKeyValue[];
    };
    scopeSpans: Array<{
      scope: {
        name: string;
        version?: string;
      };
      spans: OtelSpan[];
    }>;
  }>;
}

export interface OtelLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano?: string;
  severityNumber?: number;
  severityText?: string;
  body?: OtelAnyValue;
  attributes: OtelKeyValue[];
  traceId?: string;
  spanId?: string;
}

export interface ExportLogsServiceRequest {
  resourceLogs: Array<{
    resource: {
      attributes: OtelKeyValue[];
    };
    scopeLogs: Array<{
      scope: {
        name: string;
        version?: string;
      };
      logRecords: OtelLogRecord[];
    }>;
  }>;
}
