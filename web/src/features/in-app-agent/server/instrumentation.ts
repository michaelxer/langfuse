import { EventType } from "@ag-ui/core";
import { getInternalTracingHandler, logger } from "@langfuse/shared/src/server";

import type {
  AgUiEvent,
  AgUiRunAgentInput,
} from "@/src/features/in-app-agent/schema";
import { assertUnreachable } from "@/src/utils/types";

export type InAppAgentTracingConfig = {
  environment: string;
  metadata: Record<string, unknown>;
  userId: string;
  traceId: string;
  targetProjectId: string;
};

export type InAppAgentInstrumentationParams = {
  input: AgUiRunAgentInput;
  tracing?: InAppAgentTracingConfig;
};

const IN_APP_AGENT_TRACE_NAME = "in-app-agent";
const IN_APP_AGENT_SPAN_NAME = "agent-run";
const INSTRUMENTED_EVENT_TYPES = [
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_RESULT,
  EventType.TOOL_CALL_END,
  EventType.RUN_ERROR,
  EventType.RUN_FINISHED,
] as const;

type InstrumentedAgUiEventType = Extract<
  AgUiEvent["type"],
  (typeof INSTRUMENTED_EVENT_TYPES)[number]
>;
type InstrumentedAgUiEvent = AgUiEvent & { type: InstrumentedAgUiEventType };
type InternalTracingHandler = ReturnType<typeof getInternalTracingHandler>;
type InAppAgentTrace = ReturnType<
  InternalTracingHandler["handler"]["langfuse"]["trace"]
>;
type InAppAgentSpan = ReturnType<InAppAgentTrace["span"]>;

export function createInAppAgentInstrumentation({
  input,
  tracing,
}: InAppAgentInstrumentationParams) {
  if (!tracing?.targetProjectId) {
    return undefined;
  }

  try {
    return new InAppAgentInstrumentation({
      input,
      metadata: tracing.metadata,
      userId: tracing.userId,
      traceId: tracing.traceId,
      targetProjectId: tracing.targetProjectId,
      environment: tracing.environment,
    });
  } catch (error) {
    logger.warn("Failed to initialize in-app agent Langfuse tracing", error);
    return undefined;
  }
}

export class InAppAgentInstrumentation {
  private readonly processTracedEvents: () => Promise<void>;
  private readonly trace: InAppAgentTrace;
  private readonly span: InAppAgentSpan;
  private readonly toolSpans = new Map<
    string,
    {
      span: InAppAgentSpan;
      args: string;
      argsComplete: boolean;
      output?: unknown;
    }
  >();
  private readonly metadata: Record<string, unknown>;
  private output = "";
  private ended = false;

  constructor(params: {
    input: AgUiRunAgentInput;
    metadata: Record<string, unknown>;
    userId: string;
    traceId: string;
    targetProjectId: string;
    environment: string;
  }) {
    this.metadata = params.metadata;

    const { handler, processTracedEvents } = getInternalTracingHandler({
      targetProjectId: params.targetProjectId,
      traceId: params.traceId,
      traceName: IN_APP_AGENT_TRACE_NAME,
      environment: params.environment,
      userId: params.userId,
      metadata: params.metadata,
    });
    this.processTracedEvents = processTracedEvents;

    this.trace = handler.langfuse.trace({
      id: params.traceId,
      name: IN_APP_AGENT_TRACE_NAME,
      userId: params.userId,
      sessionId: params.input.threadId,
      metadata: params.metadata,
      tags: ["in-app-agent"],
    });
    this.span = this.trace.span({
      name: IN_APP_AGENT_SPAN_NAME,
      input: getLastUserMessageText(params.input),
      metadata: params.metadata,
    });
  }

  recordEvents(events: AgUiEvent[]) {
    if (this.ended) {
      return;
    }

    for (const event of events) {
      if (shouldInstrumentAgUiEvent(event)) {
        this.recordEvent(event);
      }
    }
  }

  endWithError(error: unknown) {
    if (this.ended) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    this.endOpenToolSpans({ error: message }, message);
    this.span.update({
      output: this.output || undefined,
      level: "ERROR",
      statusMessage: message,
      metadata: {
        ...this.metadata,
        error: message,
      },
    });
    this.trace.update({
      metadata: { ...this.metadata, error: message },
    });
    this.span.end();
    this.ended = true;
  }

  end(params?: { aborted?: boolean; result?: unknown }) {
    if (this.ended) {
      return;
    }

    this.endOpenToolSpans(params?.aborted ? { aborted: true } : undefined);
    const metadata = {
      ...this.metadata,
      ...(params?.aborted ? { aborted: true } : {}),
      ...(params?.result ? { result: params.result } : {}),
    };
    this.span.update({
      output: this.output || undefined,
      metadata,
    });
    this.trace.update({
      metadata,
    });
    this.span.end();
    this.ended = true;
  }

  flush() {
    this.processTracedEvents().catch((error) => {
      logger.warn("Failed to flush in-app agent Langfuse tracing", error);
    });
  }

  private recordEvent(event: InstrumentedAgUiEvent) {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_CONTENT:
        if (typeof event.delta === "string") {
          this.output += event.delta;
        }
        return;
      case EventType.TOOL_CALL_START:
        this.startToolSpan(event);
        return;
      case EventType.TOOL_CALL_ARGS:
        this.appendToolArgs(event);
        return;
      case EventType.TOOL_CALL_RESULT:
        this.recordToolResult(event);
        return;
      case EventType.TOOL_CALL_END:
        this.endToolSpan(event);
        return;
      case EventType.RUN_ERROR:
        this.endWithError(
          typeof event.message === "string"
            ? event.message
            : "Unknown assistant error",
        );
        return;
      case EventType.RUN_FINISHED:
        this.end({ result: event.result });
        return;
      default:
        assertUnreachable(event.type);
    }
  }

  private startToolSpan(event: AgUiEvent) {
    if (typeof event.toolCallId !== "string") {
      return;
    }

    const name =
      typeof event.toolCallName === "string" ? event.toolCallName : "tool-call";
    this.toolSpans.set(event.toolCallId, {
      span: this.span.span({ name: `tool:${name}`, input: undefined }),
      args: "",
      argsComplete: false,
    });
  }

  private appendToolArgs(event: AgUiEvent) {
    if (
      typeof event.toolCallId !== "string" ||
      typeof event.delta !== "string"
    ) {
      return;
    }

    const tool = this.toolSpans.get(event.toolCallId);
    if (tool) {
      tool.args += event.delta;
    }
  }

  private recordToolResult(event: AgUiEvent) {
    if (typeof event.toolCallId !== "string") {
      return;
    }

    const tool = this.toolSpans.get(event.toolCallId);
    if (tool) {
      tool.output = event.content;
      this.endToolSpanIfComplete(event.toolCallId, tool);
    }
  }

  private endToolSpan(event: AgUiEvent) {
    if (typeof event.toolCallId !== "string") {
      return;
    }

    const tool = this.toolSpans.get(event.toolCallId);
    if (!tool) {
      return;
    }

    tool.argsComplete = true;
    this.endToolSpanIfComplete(event.toolCallId, tool);
  }

  private endToolSpanIfComplete(
    toolCallId: string,
    tool: {
      span: InAppAgentSpan;
      args: string;
      argsComplete: boolean;
      output?: unknown;
    },
  ) {
    if (!tool.argsComplete || tool.output === undefined) {
      return;
    }

    tool.span.update({
      input: parseJsonOrString(tool.args),
      output: tool.output,
    });
    tool.span.end();
    this.toolSpans.delete(toolCallId);
  }

  private endOpenToolSpans(
    metadata?: Record<string, unknown>,
    statusMessage?: string,
  ) {
    for (const [toolCallId, tool] of this.toolSpans.entries()) {
      tool.span.update({
        input: parseJsonOrString(tool.args),
        output: tool.output,
        ...(statusMessage ? { level: "ERROR" as const, statusMessage } : {}),
        metadata: metadata ? { ...metadata, toolCallId } : { toolCallId },
      });
      tool.span.end();
      this.toolSpans.delete(toolCallId);
    }
  }
}

function getLastUserMessageText(input: AgUiRunAgentInput): string | undefined {
  const lastMessage = input.messages.at(-1);

  if (lastMessage?.role !== "user") {
    return undefined;
  }

  if (typeof lastMessage.content === "string") {
    return lastMessage.content;
  }

  return lastMessage.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function parseJsonOrString(value: string): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function shouldInstrumentAgUiEvent(
  event: AgUiEvent,
): event is InstrumentedAgUiEvent {
  return INSTRUMENTED_EVENT_TYPES.some((type) => type === event.type);
}
