/**
 * VOX-002 — a habla listener's voice poll is its heartbeat and takes its
 * principal's pending sentences oldest first, exactly once, dropping any
 * older than sixty seconds. Driven through real HTTP and the real `/mcp`.
 */

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  callMcp,
  failureSchema,
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
const artifactListingSchema = z.object({artifacts: z.array(z.unknown())})
  .loose();

describe("voice listener poll", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let listener: RegisteredAgent;

  beforeEach(async () => {
    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    client = new ApiClient(server, installation.apiToken);
    listener = await registerListener(client, "habla");
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("VOX-002-B: oldest first, once, and an empty poll keeps the listener connected", async () => {
    expect.hasAssertions();
    expect((await client.voice(listener.id, 0)).status).toBe(204);
    expect(await say("one")).toBe(true);
    clock.advance(1_000);
    expect(await say("two")).toBe(true);

    const poll = await client.voice(listener.id, 0);
    expect(poll.status).toBe(200);
    expect(voiceMessagesSchema.parse(await poll.json()).messages
      .map(({text}) => text)).toEqual(["one", "two"]);

    // Taken means gone: a held poll answers empty at its bound.
    clock.advance(80_000);
    const startedAt = Date.now();
    const empty = await client.voice(listener.id, 1);
    const elapsed = Date.now() - startedAt;
    expect(empty.status).toBe(204);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_500);

    // Only that empty poll's heartbeat keeps the listener inside the window.
    clock.advance(80_000);
    expect(await say("three")).toBe(true);
    expect((await client.voice(listener.id, 0)).status).toBe(200);

    // A sentence said while a poll is held is answered inside the same wait.
    const heldStartedAt = Date.now();
    const held = client.voice(listener.id, 8);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await say("late")).toBe(true);
    const answered = await held;
    expect(answered.status).toBe(200);
    expect(voiceMessagesSchema.parse(await answered.json()).messages
      .map(({text}) => text)).toEqual(["late"]);
    expect(Date.now() - heldStartedAt).toBeLessThan(8_000);
  });

  test("VOX-002-F: expired, foreign, and non-habla polls get nothing, and voice is never an artifact", async () => {
    expect.hasAssertions();
    const artifactsBefore = await listArtifacts();
    expect((await client.voice(listener.id, 0)).status).toBe(204);
    expect(await say("Expires unheard.")).toBe(true);
    clock.advance(61_000);
    expect((await client.voice(listener.id, 0)).status).toBe(204);

    // Another principal can neither poll this listener nor receive its voice.
    const administrator = await signInAdministrator(server, installation);
    const other = new ApiClient(
      server,
      await issueApiKey(server, administrator, ["agent:connect"], "Other habla"),
    );
    const othersListener = await registerListener(other, "habla");
    expect(await say("Only for the owner.")).toBe(true);
    await expectFailure(other.voice(listener.id, 0), 403);
    expect((await other.voice(othersListener.id, 0)).status).toBe(204);

    await expectFailure(client.voice("agt_unknown", 0), 404);
    const pi = await registerListener(client, "pi");
    await expectFailure(client.voice(pi.id, 0), 422);

    const owned = await client.voice(listener.id, 0);
    expect(owned.status).toBe(200);
    expect(voiceMessagesSchema.parse(await owned.json()).messages
      .map(({text}) => text)).toEqual(["Only for the owner."]);

    expect(await listArtifacts()).toEqual(artifactsBefore);
  });

  async function listArtifacts(): Promise<readonly unknown[]> {
    const response = await client.fetch("/api/v1/artifacts?limit=100");
    expect(response.status).toBe(200);
    return artifactListingSchema.parse(await response.json()).artifacts;
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

async function expectFailure(
  pending: Promise<Response>,
  status: number,
): Promise<void> {
  const response = await pending;
  expect(response.status).toBe(status);
  failureSchema.parse(await response.json());
}

function registerListener(
  client: ApiClient,
  kind: string,
): Promise<RegisteredAgent> {
  return client.registerAgent({
    connectionKey: `voice-take-${kind}-${crypto.randomUUID()}`,
    displayName: kind,
    kind,
    workingDirectory: "/home/user",
  });
}
