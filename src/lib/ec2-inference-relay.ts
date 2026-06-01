import { NextResponse } from "next/server";

import { normalizeRealtimeInferenceResponse } from "@/lib/inference-normalizer";

export const MAX_CSV_SIZE_BYTES = 4 * 1024 * 1024;
export const CSV_FILE_PATTERN = /\.csv$/i;

const DEFAULT_TIMEOUT_MS = 1_200_000;

export function getRequiredServerEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getTimeoutMs() {
  const value = Number(process.env.EC2_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

export function getEc2Endpoint(pathSuffix = "") {
  const baseEndpoint = getRequiredServerEnv("EC2_REALTIME_LEARNING_URL");

  if (!baseEndpoint) {
    return null;
  }

  return `${baseEndpoint.replace(/\/+$/, "")}${pathSuffix}`;
}

export function buildEc2Headers() {
  const apiKey = getRequiredServerEnv("EC2_INFERENCE_API_KEY");

  if (!apiKey) {
    return null;
  }

  const headers = new Headers();
  headers.set("x-api-key", apiKey);

  return headers;
}

export function extractErrorMessage(payload: unknown, defaultMessage: string) {
  if (payload && typeof payload === "object") {
    const candidate = payload as Record<string, unknown>;

    if (typeof candidate.error === "string") {
      return candidate.error;
    }

    if (typeof candidate.detail === "string") {
      return candidate.detail;
    }
  }

  return defaultMessage;
}

export async function readEc2Payload(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? await response.json()
    : await response.text();
}

export function normalizeOrBadGateway(payload: unknown) {
  const normalizedPayload = normalizeRealtimeInferenceResponse(payload);

  if (!normalizedPayload) {
    return NextResponse.json(
      {
        error:
          "EC2 responded, but the payload did not match the expected realtime inference contract.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json(normalizedPayload);
}

export function validateFeatureCsv(featureCsv: FormDataEntryValue | null) {
  if (!(featureCsv instanceof File)) {
    return {
      error: "Attach one feature CSV file in the featureCsv field.",
      status: 400,
    };
  }

  if (!CSV_FILE_PATTERN.test(featureCsv.name)) {
    return {
      error: "Only .csv feature files are supported.",
      status: 400,
    };
  }

  if (featureCsv.size === 0) {
    return {
      error: "The selected CSV file is empty.",
      status: 400,
    };
  }

  if (featureCsv.size > MAX_CSV_SIZE_BYTES) {
    return {
      error:
        "This relay accepts CSV files up to 4 MB. If your feature CSV grows beyond the Vercel relay limit, upload directly to EC2 or S3.",
      status: 413,
    };
  }

  return null;
}
