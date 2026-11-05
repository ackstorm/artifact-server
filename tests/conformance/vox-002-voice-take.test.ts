/**
 * VOX-002 — a habla listener's voice poll is its heartbeat and takes its
 * principal's pending sentences oldest first, exactly once, dropping any
 * older than sixty seconds. Driven through real HTTP and the real `/mcp`.
 */

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  agentListSchema,
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
import {publishNew} from "../support/publishing.js";

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

    // A caller without agent:connect cannot poll, even its own principal's.
    const readOnly = new ApiClient(
      server,
      await issueApiKey(server, administrator, ["artifact:read"], "Read only"),
    );
    await expectFailure(readOnly.voice(listener.id, 0), 403);

    const owned = await client.voice(listener.id, 0);
    expect(owned.status).toBe(200);
    expect(voiceMessagesSchema.parse(await owned.json()).messages
      .map(({text}) => text)).toEqual(["Only for the owner."]);

    expect(await listArtifacts()).toEqual(artifactsBefore);

    // A habla listener only speaks: a bundle sent to it is refused.
    const published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Voice</title>",
      idempotencyKey: "voice-take-publish",
      name: "Voice report",
    })).body;
    const thread = await client.openThread(
      published,
      "Not for a listener.",
      "voice-take-thread",
    );
    const refused = await client.sendDispatch({
      agentId: listener.id,
      idempotencyKey: "voice-take-dispatch",
      projectId: published.artifact.projectId,
      threadIds: [thread.id],
    });
    expect(refused.status).toBe(422);
    expect(failureSchema.parse(await refused.json()).error.code)
      .toBe("INVALID_DISPATCH");
  });

  test("VOX-002: re-checks inside a held poll do not bump the heartbeat", async () => {
    expect.hasAssertions();
    const heartbeatStamp = clock.now().toISOString();
    const held = client.voice(listener.id, 3);
    await new Promise((resolve) => setTimeout(resolve, 400));
    clock.advance(45_000);
    expect(await lastSeenAt()).toBe(heartbeatStamp);
    expect((await held).status).toBe(204);
    expect(await lastSeenAt()).toBe(heartbeatStamp);
  });

  test("VOX-002: concurrent polls take each message once, at most twenty per poll", async () => {
    expect.hasAssertions();
    const second = await registerListener(client, "habla");
    const heldPolls = Promise.all([
      client.voice(listener.id, 2),
      client.voice(second.id, 2),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await say("a")).toBe(true);
    expect(await say("b")).toBe(true);
    expect((await takenTexts(await heldPolls)).toSorted()).toEqual(["a", "b"]);

    const queued = Array.from({length: 21}, (_, index) => `m${index}`);
    // Said one after another, a millisecond apart, so oldest first is exact.
    const said = await queued.reduce<Promise<readonly boolean[]>>(
      async (prior, text) => {
        const answers = await prior;
        clock.advance(1);
        return [...answers, await say(text)];
      },
      Promise.resolve([]),
    );
    expect(said).toEqual(queued.map(() => true));
    const first = await client.voice(listener.id, 0);
    expect(await takenTexts([first])).toEqual(queued.slice(0, 20));
    expect(await takenTexts(await Promise.all([
      client.voice(listener.id, 0),
      client.voice(second.id, 0),
    ]))).toEqual(queued.slice(20));
  });

  test("VOX-002: a poll whose client left takes nothing on its re-check", async () => {
    expect.hasAssertions();
    const startedAt = Date.now();
    const leaving = new AbortController();
    const abandoned = client.fetch(
      `/api/v1/agents/${listener.id}/voice?wait=5`,
      {method: "POST", signal: leaving.signal},
    ).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    leaving.abort();
    await abandoned;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await say("Still here.")).toBe(true);

    // Past the abandoned poll's one-second re-check.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, startedAt + 1_600 - Date.now()))
    );
    const fresh = await client.voice(listener.id, 0);
    expect(await takenTexts([fresh])).toEqual(["Still here."]);
  });

  async function lastSeenAt(): Promise<string | undefined> {
    const response = await client.listAgents();
    expect(response.status).toBe(200);
    return agentListSchema.parse(await response.json()).items
      .find(({id}) => id === listener.id)?.lastSeenAt;
  }

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

/** Every text the polls took, in poll order; empty polls answer 204. */
async function takenTexts(
  polls: readonly Response[],
): Promise<readonly string[]> {
  const taken = await Promise.all(polls.map(async (poll) => {
    if (poll.status === 204) return [];
    expect(poll.status).toBe(200);
    return voiceMessagesSchema.parse(await poll.json()).messages
      .map(({text}) => text);
  }));
  return taken.flat();
}

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
