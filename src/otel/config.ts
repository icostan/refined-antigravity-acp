/**
 * OpenTelemetry environment variable parsing and configuration.
 */

export interface OtelConfig {
  enabled: boolean;
  serviceName: string;
  resourceAttributes: Record<string, string>;
  tracesEndpoint?: string | undefined;
  logsEndpoint?: string | undefined;
  protocol: "http/json" | "http/protobuf" | "grpc";
  tracesHeaders: Record<string, string>;
  logsHeaders: Record<string, string>;
  logUserPrompts: boolean;
  logAssistantResponses: boolean;
}

export function parseHeaderString(headerStr?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headerStr) return headers;
  for (const pair of headerStr.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key) {
        try {
          headers[key] = decodeURIComponent(val);
        } catch {
          headers[key] = val;
        }
      }
    }
  }
  return headers;
}

export function parseResourceAttributes(attrStr?: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrStr) return attrs;
  for (const pair of attrStr.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key) attrs[key] = val;
    }
  }
  return attrs;
}

function resolveEndpoint(
  explicitEndpoint: string | undefined,
  baseEndpoint: string | undefined,
  signalPath: "/v1/traces" | "/v1/logs",
  signalExporter: string | undefined,
): string | undefined {
  if (explicitEndpoint && explicitEndpoint.trim()) {
    return explicitEndpoint.trim();
  }
  if (baseEndpoint && baseEndpoint.trim()) {
    const trimmed = baseEndpoint.trim();
    if (trimmed.endsWith(signalPath)) return trimmed;
    return `${trimmed.replace(/\/+$/, "")}${signalPath}`;
  }
  if (signalExporter === "otlp") {
    return `http://localhost:4318${signalPath}`;
  }
  return undefined;
}

function parseProtocol(raw?: string): "http/json" | "http/protobuf" | "grpc" {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "http/protobuf" || normalized === "grpc") {
    return normalized;
  }
  return "http/json";
}

function buildOptedInConfig(env: NodeJS.ProcessEnv, baseEndpoint?: string): OtelConfig {
  const serviceName =
    env.OTEL_SERVICE_NAME?.trim() ||
    parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES)["service.name"] ||
    "refined-antigravity-acp";

  const resourceAttributes = {
    ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
    "service.name": serviceName,
  };

  const baseHeaders = parseHeaderString(env.OTEL_EXPORTER_OTLP_HEADERS);
  const tracesHeaders = {
    ...baseHeaders,
    ...parseHeaderString(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
  };
  const logsHeaders = { ...baseHeaders, ...parseHeaderString(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS) };

  const tracesExporter = env.OTEL_TRACES_EXPORTER?.trim().toLowerCase();
  const logsExporter = env.OTEL_LOGS_EXPORTER?.trim().toLowerCase();

  return {
    enabled: true,
    serviceName,
    resourceAttributes,
    tracesEndpoint: resolveEndpoint(
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      baseEndpoint,
      "/v1/traces",
      tracesExporter,
    ),
    logsEndpoint: resolveEndpoint(
      env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      baseEndpoint,
      "/v1/logs",
      logsExporter,
    ),
    protocol: parseProtocol(env.OTEL_EXPORTER_OTLP_PROTOCOL),
    tracesHeaders,
    logsHeaders,
    logUserPrompts: env.OTEL_LOG_USER_PROMPTS === "1",
    logAssistantResponses: env.OTEL_LOG_ASSISTANT_RESPONSES === "1",
  };
}

function checkIsOptedIn(env: NodeJS.ProcessEnv): boolean {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || "";
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_TRACES_EXPORTER || "";
  const logs = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || env.OTEL_LOGS_EXPORTER || "";
  return Boolean(endpoint.trim() || traces.trim() || logs.trim());
}

export function getOtelConfig(env: NodeJS.ProcessEnv = process.env): OtelConfig {
  if (env.OTEL_SDK_DISABLED === "true" || !checkIsOptedIn(env)) {
    return createDisabledConfig();
  }
  return buildOptedInConfig(env, env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());
}

function createDisabledConfig(): OtelConfig {
  return {
    enabled: false,
    serviceName: "refined-antigravity-acp",
    resourceAttributes: {},
    protocol: "http/json",
    tracesHeaders: {},
    logsHeaders: {},
    logUserPrompts: false,
    logAssistantResponses: false,
  };
}
