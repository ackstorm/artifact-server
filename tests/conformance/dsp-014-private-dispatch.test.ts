import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  ApiClient,
  dispatchCreationSchema,
  dispatchPageSchema,
  failureSchema,
  issueApiKey,
  type RegisteredAgent,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew} from "../support/publishing.js";

describe("agent dispatch of private artifacts", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let agent: RegisteredAgent;
  let foreignAgent: RegisteredAgent;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    agent = await client.registerAgent({
      agentSessionId: "pi-session-private",
      connectionKey: "dispatch-private-connection-key",
      displayName: "site",
      workingDirectory: "/work/site",
    });
    const administrator = await signInAdministrator(server, installation);
    foreignAgent = await new ApiClient(
      server,
      await issueApiKey(server, administrator, ["agent:connect"], "Foreign bridge"),
    ).registerAgent({
      connectionKey: "dispatch-private-foreign-connection-key",
      displayName: "foreign",
      workingDirectory: "/work/foreign",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-014-B DSP-014-F: threads of a Members artifact dispatch to any agent and a Private artifact's to its owner's agent, while another principal's agent is refused with ARTIFACT_PRIVATE and the thread stays undispatched", async () => {
    expect.hasAssertions();
    const shared = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Shared</title>",
      idempotencyKey: "dispatch-private-shared-publish",
      name: "Shared report",
    })).body;
    const sharedThread = await client.openThread(
      shared,
      "An annotation on the shared artifact.",
      "dispatch-private-shared-thread",
    );
    const accepted = await client.sendDispatch({
      agentId: foreignAgent.id,
      idempotencyKey: "dispatch-private-shared-send",
      projectId: shared.artifact.projectId,
      threadIds: [sharedThread.id],
    });
    expect(accepted.status).toBe(201);
    const created = dispatchCreationSchema.parse(await accepted.json());

    const hidden = (await publishNew(server, installation, {
      accessSetting: "private",
      content: "<!doctype html><title>Hidden</title>",
      idempotencyKey: "dispatch-private-hidden-publish",
      name: "Hidden report",
    })).body;
    const hiddenThread = await client.openThread(
      hidden,
      "An annotation on the private artifact.",
      "dispatch-private-hidden-thread",
    );
    const refused = await client.sendDispatch({
      agentId: foreignAgent.id,
      idempotencyKey: "dispatch-private-hidden-send",
      projectId: hidden.artifact.projectId,
      threadIds: [hiddenThread.id],
    });
    expect(refused.status).toBe(409);
    const failure = failureSchema.parse(await refused.json()).error;
    expect(failure.code).toBe("ARTIFACT_PRIVATE");
    expect(failure.message).toBe(
      "This artifact is private. Share it with Members before sending its threads to an agent.",
    );

    const dispatches = dispatchPageSchema.parse(
      await (await client.listDispatches(hidden.artifact.projectId)).json(),
    );
    expect(dispatches.items.map((dispatch) => dispatch.id))
      .toEqual([created.dispatch.id]);
    expect(await client.listThreadIds(hidden)).toEqual([hiddenThread.id]);

    // The owner's own agent acts as the owner, so it can read the artifact.
    const owned = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "dispatch-private-owner-send",
      projectId: hidden.artifact.projectId,
      threadIds: [hiddenThread.id],
    });
    expect(owned.status).toBe(201);
    expect(dispatchCreationSchema.parse(await owned.json()).dispatch.threadIds)
      .toEqual([hiddenThread.id]);
  });
});
