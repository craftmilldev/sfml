import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";

const posthogEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(posthogEnvPath)) process.loadEnvFile(posthogEnvPath);

const posthogProjectToken = process.env.POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.POSTHOG_HOST;

// This provider is deliberately local rather than registered globally: only the dedicated logger
// below uses it, so existing CLI and dependency logging remains in its current outputs.
const loggerProvider =
  posthogProjectToken && posthogHost
    ? new LoggerProvider({
        resource: resourceFromAttributes({ "service.name": "sfml-cli" }),
        processors: [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({
              url: `${posthogHost.replace(/\/$/, "")}/i/v1/logs`,
              headers: { Authorization: `Bearer ${posthogProjectToken}` },
            }),
          }),
        ],
      })
    : undefined;

const posthogLogger = loggerProvider?.getLogger("sfml-posthog-logs");

/** Emits only integration-owned, non-user-data CLI lifecycle records to PostHog Logs. */
export function emitPostHogLog(body: string, attributes: Record<string, string | boolean>): void {
  posthogLogger?.emit({ severityText: "info", body, attributes });
}

/** Flushes the dedicated log exporter without affecting existing application loggers. */
export async function shutdownPostHogLogs(): Promise<void> {
  await loggerProvider?.shutdown();
}
