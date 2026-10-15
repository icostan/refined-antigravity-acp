import { afterEach, describe, expect, it } from "vitest";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";

describe("flattened-model-efforts e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) await client.close().catch(() => {});
    }
  });

  it("problem: raw agy returns flattened model variants in models.availableModels and rejects set_model with base model ID", async () => {
    const rawClient = await spawnRawAgy();
    activeClients.push(rawClient);
    await rawClient.initialize();
    const res = await rawClient.newSession();

    const models = (res.models as { availableModels?: Array<{ modelId?: string }> }) ?? {};
    const available = models.availableModels ?? [];
    expect(available.length).toBeGreaterThan(0);

    // Raw agy returns flattened model variants with -high, -low, -medium
    const hasFlattened = available.some(
      (m) =>
        m.modelId?.endsWith("-high") ||
        m.modelId?.endsWith("-low") ||
        m.modelId?.endsWith("-medium"),
    );
    expect(hasFlattened).toBe(true);

    // Attempting to set a clean base model ID fails upstream with -32602
    await rawClient.send({
      jsonrpc: "2.0",
      id: 901,
      method: "session/set_model",
      params: { sessionId: res.sessionId, modelId: "gemini-4-argon" },
    });
    const setModelReply = await rawClient.waitForResponse(901);
    expect("error" in setModelReply).toBe(true);
    if ("error" in setModelReply && setModelReply.error) {
      expect(setModelReply.error.code).toBe(-32602);
    }

    await rawClient.close();
  });

  it("solution: wrapped connector collapses models.availableModels and adapts set_model to composite ID", async () => {
    const wrappedClient = await spawnWrapped();
    activeClients.push(wrappedClient);
    await wrappedClient.initialize();
    const res = await wrappedClient.newSession();

    const models = (res.models as { availableModels?: Array<{ modelId?: string }> }) ?? {};
    const available = models.availableModels ?? [];
    expect(available.length).toBeGreaterThan(0);

    // Collapsed models should have clean base IDs without effort suffixes
    const hasFlattened = available.some(
      (m) =>
        m.modelId?.endsWith("-high") ||
        m.modelId?.endsWith("-low") ||
        m.modelId?.endsWith("-medium"),
    );
    expect(hasFlattened).toBe(false);

    // Base models appear uniquely (e.g. gemini-4-argon, gemini-3.8-flash)
    const modelIds = available.map((m) => m.modelId);
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds).toContain("gemini-4-argon");

    // Setting a clean base model ID succeeds through the wrapper (translated to composite upstream)
    await wrappedClient.send({
      jsonrpc: "2.0",
      id: 902,
      method: "session/set_model",
      params: { sessionId: res.sessionId, modelId: "gemini-4-argon" },
    });
    const setModelReply = await wrappedClient.waitForResponse(902);
    expect("error" in setModelReply).toBe(false);

    // Verify thinking_level is present and not duplicated
    const configOptions =
      (res.configOptions as Array<{ id?: string; options?: Array<{ value?: string }> }>) ?? [];
    const effortOptions = configOptions.filter(
      (o) => o.id === "thinking_level" || o.id === "thought_level",
    );
    expect(effortOptions).toHaveLength(1);

    await wrappedClient.close();
  });
});
