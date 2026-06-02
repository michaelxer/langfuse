import { EventType } from "@ag-ui/core";

import type { AgUiRunAgentInput } from "@/src/features/in-app-agent/schema";
import { InAppAgentInstrumentation } from "@/src/features/in-app-agent/server/instrumentation";

const traceId = "0123456789abcdef0123456789abcdef";

const mocks = vi.hoisted(() => {
  const toolSpan = {
    update: vi.fn(),
    end: vi.fn(),
  };
  const agentSpan = {
    span: vi.fn(() => toolSpan),
    update: vi.fn(),
    end: vi.fn(),
  };
  const trace = {
    span: vi.fn(() => agentSpan),
    update: vi.fn(),
  };
  const handler = {
    langfuse: {
      trace: vi.fn(() => trace),
    },
  };
  return {
    agentSpan,
    toolSpan,
    trace,
    handler,
    processTracedEvents: vi.fn(async () => undefined),
    getInternalTracingHandler: vi.fn(() => ({
      handler,
      processTracedEvents: vi.fn(async () => undefined),
    })),
  };
});

vi.mock("@langfuse/shared/src/server", () => ({
  getInternalTracingHandler: mocks.getInternalTracingHandler,
  LangfuseInternalTraceEnvironment: {
    InAppAgent: "langfuse-in-app-agent",
  },
  redis: undefined,
  ClickHouseClientManager: {
    getInstance: vi.fn(() => ({
      closeAllConnections: vi.fn(async () => undefined),
    })),
  },
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const input: AgUiRunAgentInput = {
  threadId: "thread-1",
  runId: "run-1",
  state: null,
  messages: [{ id: "message-1", role: "user", content: "hello" }],
  tools: [],
  context: [],
  forwardedProps: {},
};

describe("InAppAgentInstrumentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records agent output and tool calls as child observations", () => {
    const instrumentation = new InAppAgentInstrumentation({
      input,
      metadata: { langfuse_project_id: "project-1" },
      userId: "user-1",
      traceId,
      targetProjectId: "project-1",
      environment: "prod",
    });

    instrumentation.recordEvents([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "hi ",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "there",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "listObservations",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"limit":',
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: "10}",
      },
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool-1",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "tool-1",
        content: "tool result",
      },
      {
        type: EventType.RUN_FINISHED,
      },
    ]);

    expect(mocks.getInternalTracingHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: "prod",
        metadata: { langfuse_project_id: "project-1" },
        targetProjectId: "project-1",
        traceId,
        traceName: "in-app-agent",
        userId: "user-1",
      }),
    );
    expect(mocks.handler.langfuse.trace).toHaveBeenCalledWith(
      expect.objectContaining({ id: traceId, name: "in-app-agent" }),
    );
    expect(mocks.handler.langfuse.trace.mock.calls[0][0]).not.toHaveProperty(
      "input",
    );
    expect(mocks.trace.span).toHaveBeenCalledWith(
      expect.objectContaining({ name: "agent-run", input: "hello" }),
    );
    expect(mocks.agentSpan.span).toHaveBeenCalledWith(
      expect.objectContaining({ name: "tool:listObservations" }),
    );
    expect(mocks.toolSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { limit: 10 },
        output: "tool result",
      }),
    );
    expect(mocks.agentSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "hi there",
      }),
    );
    expect(mocks.trace.update.mock.calls[0][0]).not.toHaveProperty("output");
  });

  it("records run failures on the agent span", () => {
    const instrumentation = new InAppAgentInstrumentation({
      input,
      metadata: { langfuse_project_id: "project-1" },
      userId: "user-1",
      traceId,
      targetProjectId: "project-1",
      environment: "prod",
    });

    instrumentation.recordEvents([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "getTrace",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"traceId":"trace-1"}',
      },
    ]);
    instrumentation.endWithError(new Error("agent failed"));

    expect(mocks.toolSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { traceId: "trace-1" },
        level: "ERROR",
        statusMessage: "agent failed",
        metadata: expect.objectContaining({ error: "agent failed" }),
      }),
    );

    expect(mocks.agentSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "ERROR",
        statusMessage: "agent failed",
        metadata: expect.objectContaining({ error: "agent failed" }),
      }),
    );
  });

  it("does not write trace input and output", () => {
    const instrumentation = new InAppAgentInstrumentation({
      input,
      metadata: { langfuse_project_id: "project-1" },
      userId: "user-1",
      traceId,
      targetProjectId: "project-1",
      environment: "prod",
    });

    instrumentation.recordEvents([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "second turn output",
      },
      {
        type: EventType.RUN_FINISHED,
      },
    ]);

    expect(mocks.handler.langfuse.trace.mock.calls[0][0]).not.toHaveProperty(
      "input",
    );
    expect(mocks.agentSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({ output: "second turn output" }),
    );
    expect(mocks.trace.update.mock.calls[0][0]).not.toHaveProperty("output");
  });

  it("ignores events after instrumentation ended", () => {
    const instrumentation = new InAppAgentInstrumentation({
      input,
      metadata: { langfuse_project_id: "project-1" },
      userId: "user-1",
      traceId,
      targetProjectId: "project-1",
      environment: "prod",
    });

    instrumentation.end({});
    instrumentation.recordEvents([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-after-end",
        toolCallName: "lateTool",
      },
    ]);

    expect(mocks.agentSpan.span).not.toHaveBeenCalled();
  });
});
