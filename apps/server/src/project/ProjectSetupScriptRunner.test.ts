import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import { ProjectId, type TerminalSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectScriptPorts from "./ProjectScriptPorts.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

it.effect("resolves setup scripts through the standalone project service", () => {
  let terminalMetadata: ReadonlyArray<TerminalSummary> = [];
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Shell",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => Effect.void,
  );
  const closeIdle = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0]) => Effect.void,
  );
  const listeners: Array<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]> =
    [];
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.push(listener);
      return () => undefined;
    });
  const projectId = ProjectId.make("project:setup-runner-v2");
  const reserve = vi.fn((_input: { readonly cwd: string; readonly scriptId: string }) =>
    Effect.succeed(43123),
  );
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "vp install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
    ],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open,
          write,
          subscribe,
          closeIdle,
          readMetadata: Effect.suspend(() => Effect.succeed(terminalMetadata)),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProjectScriptPorts.ProjectScriptPorts)({ reserve }),
        NodeCrypto.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
    });
    assert.deepEqual(result, {
      status: "started",
      async: true,
      scriptId: "setup",
      scriptName: "Setup",
      scriptCommand: "vp install",
      terminalId: "setup-setup",
      cwd: "/repo-worktree",
    });
    assert.equal(open.mock.calls[0]?.[0].cwd, "/repo-worktree");
    assert.deepEqual(open.mock.calls[0]?.[0].env, {
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo-worktree",
      COLORTERM: "",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    });
    assert.equal(write.mock.calls[0]?.[0].data, "vp install\r");
    assert.equal(reserve.mock.calls.length, 0);
    const lines: string[] = [];
    const observed = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {
        onOutputLine: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      },
    });
    assert.equal(observed.status, "started");
    const listener = listeners[0]!;
    yield* listener({
      type: "output",
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "Downloading 10%\rDownloading 20%\r\nDone\n",
    });
    assert.deepEqual(lines, ["Downloading 10%", "Downloading 20%", "Done"]);
    yield* listener({ type: "closed", threadId: "thread-1", terminalId: "setup-setup" });

    const settle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
    });
    const settleTerminalId = settle.status === "started" ? settle.terminalId : "";
    assert.match(settleTerminalId, /^settle-clean-/);
    assert.equal(write.mock.calls.at(-1)?.[0].data, "cargo clean\r");

    const observedSettle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
      observeCompletion: {},
    });
    const observedTerminalId = observedSettle.status === "started" ? observedSettle.terminalId : "";
    assert.notEqual(observedTerminalId, settleTerminalId);
    const token = /__T3_SETUP_DONE___(\w+):/.exec(write.mock.calls.at(-1)?.[0].data ?? "")?.[1];
    const settleListener = listeners.at(-1)!;
    const completion = yield* Effect.forkChild(
      observedSettle.status === "started" && observedSettle.completion
        ? observedSettle.completion
        : Effect.die("no completion"),
    );
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: `\r\n__T3_SETUP_DONE___${token}:0\r\n`,
    });
    yield* Effect.yieldNow;
    assert.equal(closeIdle.mock.calls.length, 0);
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: "$ ",
    });
    assert.deepEqual((yield* Fiber.join(completion)).exitCode, 0);
    assert.deepEqual(closeIdle.mock.calls[0]?.[0], {
      threadId: "thread-1",
      terminalId: observedTerminalId,
    });

    const previewProject = {
      ...project,
      scripts: [
        {
          ...project.scripts[0]!,
          runOnWorktreeCreate: true,
          runOnSettle: true,
          reservePort: true,
          previewUrl: "http://localhost:${T3CODE_PREVIEW_PORT}",
        },
      ],
    };
    for (const trigger of ["setup", "settle", "settle"] as const) {
      const openCount = open.mock.calls.length;
      const writeCount = write.mock.calls.length;
      const preview = yield* runner.runForThread({
        threadId: "thread-preview",
        project: previewProject,
        worktreePath: "/repo-worktree",
        trigger,
        ...(trigger === "settle" ? { observeCompletion: {} } : {}),
      });
      assert.equal(preview.status, "started");
      if (preview.status !== "started") return;
      assert.equal(preview.terminalId, "script-43123");
      assert.deepEqual(reserve.mock.calls.at(-1)?.[0], {
        cwd: "/repo-worktree",
        scriptId: "setup",
      });
      assert.deepEqual(open.mock.calls.at(-1)?.[0].env, {
        T3CODE_PROJECT_ROOT: "/repo",
        T3CODE_WORKTREE_PATH: "/repo-worktree",
        T3CODE_PREVIEW_PORT: "43123",
        COLORTERM: "",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      });
      if (trigger === "settle") {
        assert.equal(open.mock.calls.length, openCount);
        assert.equal(write.mock.calls.length, writeCount);
        assert.equal(preview.async, true);
        assert.deepEqual(yield* preview.completion!, { exitCode: 0, durationMs: 0 });
      }
      terminalMetadata = [
        {
          threadId: "thread-preview",
          terminalId: preview.terminalId,
          cwd: preview.cwd,
          worktreePath: preview.cwd,
          status: trigger === "setup" ? "starting" : "running",
          hasRunningSubprocess: trigger !== "setup",
          pid: 123,
          exitCode: null,
          exitSignal: null,
          label: "Preview",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
      ];
    }
    const openCount = open.mock.calls.length;
    const writeCount = write.mock.calls.length;
    assert.deepEqual(
      yield* runner.runForThread({
        threadId: "thread-other",
        project: previewProject,
        worktreePath: "/repo-worktree",
        trigger: "settle",
      }),
      { status: "no-script" },
    );
    assert.equal(open.mock.calls.length, openCount);
    assert.equal(write.mock.calls.length, writeCount);
  }).pipe(Effect.provide(layer));
});
