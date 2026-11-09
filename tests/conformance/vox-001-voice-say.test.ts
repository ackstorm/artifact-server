/**
 * VOX-001 — voice_say queues a sentence for the caller's own principal only
 * while that principal has a connected habla listener, through the real
 * `/mcp` endpoint and the listener's real voice route.
 */

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  callMcp,
  issueApiKey,
  mcpFailed,
  MutableClock,
  type RegisteredAgent,
  signInAdministrator,
  voiceMessagesSchema,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const sayAnswerSchema = z.object({queued: z.boolean()}).strict();

describe("voice_say", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;

  beforeEach(async () => {
    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    client = new ApiClient(server, installation.apiToken);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("VOX-001-B: queues for a connected habla listener", async () => {
    expect.hasAssertions();
    const listener = await registerListener(client, "habla");
    expect((await client.voice(listener.id, 0)).status).toBe(204);

    expect(await say("  Done  ")).toBe(true);

    const poll = await client.voice(listener.id, 0);
    expect(poll.status).toBe(200);
    expect(voiceMessagesSchema.parse(await poll.json()).messages)
      .toMatchObject([{createdAt: clock.now().toISOString(), text: "Done"}]);
  });

  test("VOX-001-F: queues nothing without a connected listener of the caller", async () => {
    expect.hasAssertions();
    expect(await say("Nobody is listening.")).toBe(false);
    await expectNothingStored();

    // Another principal's connected listener does not make the caller heard.
    const administrator = await signInAdministrator(server, installation);
    const other = new ApiClient(
      server,
      await issueApiKey(server, administrator, ["agent:connect"], "Other habla"),
    );
    const othersListener = await registerListener(other, "habla");
    expect((await other.voice(othersListener.id, 0)).status).toBe(204);
    expect(await say("Not for the other principal.")).toBe(false);
    expect((await other.voice(othersListener.id, 0)).status).toBe(204);
    await expectNothingStored();

    // An agent of another kind is not a listener.
    await registerListener(client, "pi");
    expect(await say("A pi agent does not speak.")).toBe(false);
    await expectNothingStored();

    // A habla listener that stopped polling is no longer connected.
    const stale = await registerListener(client, "habla");
    clock.advance(91_000);
    expect(await say("Too late.")).toBe(false);
    expect((await client.voice(stale.id, 0)).status).toBe(204);

    // Empty, blank, and over-long text is refused, connected or not.
    const refused = await Promise.all(["", "   ", "x".repeat(501)].map((text) =>
      callMcp(server, installation.apiToken, "tools/call", "voice_say", {
        arguments: {text},
        name: "voice_say",
      })
    ));
    expect(refused.map(mcpFailed)).toEqual([true, true, true]);
    expect((await client.voice(stale.id, 0)).status).toBe(204);
  });

  /**
   * At the same clock time, a listener connecting now finds nothing queued,
   * so a refused say stored no row; the probe disconnects again afterwards.
   */
  async function expectNothingStored(): Promise<void> {
    const probe = await registerListener(client, "habla");
    expect((await client.voice(probe.id, 0)).status).toBe(204);
    const disconnected = await client.fetch(
      `/api/v1/agents/${probe.id}/disconnect`,
      {method: "POST"},
    );
    expect(disconnected.ok).toBe(true);
  }

  async function say(text: string): Promise<boolean> {
    const reply = await callMcp(
      server,
      installation.apiToken,
      "tools/call",
      "voice_say",
      {arguments: {text}, name: "voice_say"},
    );
    expect(mcpFailed(reply)).toBe(false);
    return sayAnswerSchema.parse(reply.result?.structuredContent).queued;
  }
});

function registerListener(
  client: ApiClient,
  kind: string,
): Promise<RegisteredAgent> {
  return client.registerAgent({
    connectionKey: `voice-say-${kind}-${crypto.randomUUID()}`,
    displayName: kind,
    kind,
    workingDirectory: "/home/user",
  });
}
