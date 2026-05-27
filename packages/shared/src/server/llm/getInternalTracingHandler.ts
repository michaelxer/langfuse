import CallbackHandler from "langfuse-langchain";
import type {
  InternalEventsWriter,
  ProcessedTraceEvent,
  TraceSinkParams,
} from "./types";
import {
  buildInternalTraceEventInputs,
  type InternalTraceEventInput,
} from "./internalTraceEvents";
import { processEventBatch } from "../ingestion/processEventBatch";
import { logger } from "../logger";
import { traceException } from "../instrumentation";
import { clickhouseClient } from "../clickhouse/client";
import { flattenJsonToPathArrays } from "../otel/utils";
import type { EventRecordInsertType } from "../repositories/definitions";

export function prepareInternalTraceEvents(params: {
  events: Array<{
    type: string;
    timestamp: string;
    body: Record<string, unknown>;
  }>;
  environment: string;
  prompt?: TraceSinkParams["prompt"];
}): ProcessedTraceEvent[] {
  const { events, environment, prompt } = params;

  const blockedSpanIds = new Set();
  const blockedSpanNameSubstrings = ["RunnableLambda", "OutputParser"];

  for (const event of events) {
    const eventName = "name" in event.body ? event.body.name : "";

    if (typeof eventName !== "string" || eventName.length === 0) {
      continue;
    }

    if (
      blockedSpanNameSubstrings.some((blockedSubstring) =>
        eventName.includes(blockedSubstring),
      ) &&
      "id" in event.body &&
      event.type !== "trace-create"
    ) {
      blockedSpanIds.add(event.body.id);
    }
  }

  return events
    .filter((event) => {
      if ("id" in event.body) {
        return !blockedSpanIds.has(event.body.id);
      }

      return true;
    })
    .map((event) => {
      // Inject environment into all events
      return {
        ...event,
        body: {
          ...event.body,
          environment,
        },
      };
    })
    .map((event) => {
      if (event.type === "generation-create" && prompt) {
        return {
          ...event,
          body: {
            ...event.body,
            promptName: prompt.name,
            promptVersion: prompt.version,
          },
        };
      }

      return event;
    });
}

export function getInternalTracingHandler(traceSinkParams: TraceSinkParams): {
  handler: CallbackHandler;
  processTracedEvents: () => Promise<void>;
} {
  const { prompt, targetProjectId, environment, userId } = traceSinkParams;
  const eventsWriter =
    traceSinkParams.eventsWriter ??
    (traceSinkParams.writeEventsTable
      ? createInternalEventsWriter()
      : undefined);
  const handler = new CallbackHandler({
    _projectId: targetProjectId,
    _isLocalEventExportEnabled: true,
    environment: environment,
    userId: userId,
  });

  const processTracedEvents = async () => {
    try {
      const events = await handler.langfuse._exportLocalEvents(
        traceSinkParams.targetProjectId,
      );
      const processedEvents = prepareInternalTraceEvents({
        events,
        environment,
        prompt,
      });

      // Legacy write to traces/observations tables
      try {
        await processEventBatch(
          JSON.parse(JSON.stringify(processedEvents)), // stringify to emulate network event batch from network call
          {
            validKey: true as const,
            scope: {
              projectId: traceSinkParams.targetProjectId, // Important: this controls into what project traces are ingested.
              accessLevel: "project",
            } as any,
          },
          {
            isLangfuseInternal: true,
            forwardToEventsTable: eventsWriter ? false : undefined, // Do not dual write when we already direct event write
          },
        );
      } catch (processingError) {
        traceException(processingError);
        logger.error("Failed to process traced events via legacy ingestion", {
          error: processingError,
        });
      }

      // Direct write to events table
      if (eventsWriter) {
        try {
          const { rootSpanId, eventInputs } = buildInternalTraceEventInputs({
            processedEvents,
            traceId: traceSinkParams.traceId,
            projectId: targetProjectId,
            experimentContext: eventsWriter.experimentContext,
          });

          if (eventInputs.length > 0) {
            await eventsWriter.write({ rootSpanId, eventInputs });
          }
        } catch (writeError) {
          traceException(writeError);
          logger.error("Failed to direct-write internal traced events", {
            error: writeError,
          });
        }
      }
    } catch (e) {
      logger.error("Failed to process traced events", { error: e });
    }
  };

  return { handler, processTracedEvents };
}

function createInternalEventsWriter(): InternalEventsWriter {
  return {
    write: async (params: {
      rootSpanId: string;
      eventInputs: InternalTraceEventInput[];
    }) => {
      if (params.eventInputs.length === 0) {
        return;
      }

      await clickhouseClient().insert({
        table: "events_full",
        format: "JSONEachRow",
        values: params.eventInputs.map(createEventRecord),
      });
    },
  };
}

function createEventRecord(
  eventData: InternalTraceEventInput,
): EventRecordInsertType {
  const now = getMicrosecondTimestamp();
  const flattened = eventData.metadata
    ? flattenJsonToPathArrays(eventData.metadata)
    : { names: [], values: [] };

  return {
    id: eventData.spanId,
    project_id: eventData.projectId,
    trace_id: eventData.traceId,
    span_id: eventData.spanId,
    parent_span_id: eventData.parentSpanId,
    name: eventData.name ?? "",
    type: eventData.type ?? "SPAN",
    environment: eventData.environment ?? "default",
    version: eventData.version,
    release: eventData.release,
    tags: eventData.tags ?? [],
    bookmarked: eventData.bookmarked ?? false,
    public: eventData.public ?? false,
    trace_name: eventData.traceName,
    user_id: eventData.userId,
    session_id: eventData.sessionId,
    level: eventData.level ?? "DEFAULT",
    status_message: eventData.statusMessage,
    start_time: getMicrosecondTimestamp(eventData.startTimeISO),
    end_time: getMicrosecondTimestamp(eventData.endTimeISO),
    completion_start_time: eventData.completionStartTime
      ? getMicrosecondTimestamp(eventData.completionStartTime)
      : null,
    prompt_id: "",
    prompt_name: eventData.promptName,
    prompt_version: parseUInt16(eventData.promptVersion),
    model_id: "",
    provided_model_name: eventData.modelName,
    model_parameters: eventData.modelParameters
      ? typeof eventData.modelParameters === "string"
        ? JSON.parse(eventData.modelParameters)
        : eventData.modelParameters
      : {},
    provided_usage_details: eventData.providedUsageDetails ?? {},
    usage_details: eventData.usageDetails ?? {},
    provided_cost_details: eventData.providedCostDetails ?? {},
    cost_details: eventData.costDetails ?? {},
    usage_pricing_tier_id: undefined,
    usage_pricing_tier_name: undefined,
    tool_definitions: eventData.toolDefinitions ?? {},
    tool_calls: eventData.toolCalls ?? [],
    tool_call_names: eventData.toolCallNames ?? [],
    input: eventData.input,
    output: eventData.output,
    metadata_names: flattened.names,
    metadata_values: flattened.values.map((value) => value ?? ""),
    source: eventData.source,
    service_name: eventData.serviceName,
    service_version: eventData.serviceVersion,
    scope_name: eventData.scopeName,
    scope_version: eventData.scopeVersion,
    telemetry_sdk_language: eventData.telemetrySdkLanguage,
    telemetry_sdk_name: eventData.telemetrySdkName,
    telemetry_sdk_version: eventData.telemetrySdkVersion,
    blob_storage_file_path: "",
    event_bytes: eventData.eventBytes ?? 0,
    experiment_id: eventData.experimentId,
    experiment_name: eventData.experimentName,
    experiment_metadata_names: eventData.experimentMetadataNames ?? [],
    experiment_metadata_values: eventData.experimentMetadataValues ?? [],
    experiment_description: eventData.experimentDescription,
    experiment_dataset_id: eventData.experimentDatasetId,
    experiment_item_id: eventData.experimentItemId,
    experiment_item_version: eventData.experimentItemVersion,
    experiment_item_expected_output: eventData.experimentItemExpectedOutput,
    experiment_item_metadata_names: eventData.experimentItemMetadataNames ?? [],
    experiment_item_metadata_values:
      eventData.experimentItemMetadataValues ?? [],
    experiment_item_root_span_id: eventData.experimentItemRootSpanId,
    created_at: now,
    updated_at: now,
    event_ts: now,
    is_deleted: 0,
  };
}

function getMicrosecondTimestamp(date?: string): number {
  const timestamp = date ? new Date(date).getTime() : Date.now();
  return timestamp * 1000;
}

function parseUInt16(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : undefined;
}
