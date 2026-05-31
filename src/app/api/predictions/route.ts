import { NextResponse } from "next/server";

import { isRealtimeInferenceResponse } from "@/lib/inference-contract";

const MAX_CSV_SIZE_BYTES = 4 * 1024 * 1024;
const CSV_FILE_PATTERN = /\.csv$/i;
const DEFAULT_TIMEOUT_MS = 180_000;

export const runtime = "nodejs";

function getRequiredServerEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function getTimeoutMs() {
  const value = Number(process.env.EC2_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function extractErrorMessage(payload: unknown, defaultMessage: string) {
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

export async function POST(request: Request) {
  const formData = await request.formData();
  const featureCsv = formData.get("featureCsv");

  if (!(featureCsv instanceof File)) {
    return NextResponse.json(
      { error: "Attach one feature CSV file in the featureCsv field." },
      { status: 400 },
    );
  }

  if (!CSV_FILE_PATTERN.test(featureCsv.name)) {
    return NextResponse.json(
      { error: "Only .csv feature files are supported." },
      { status: 400 },
    );
  }

  if (featureCsv.size === 0) {
    return NextResponse.json(
      { error: "The selected CSV file is empty." },
      { status: 400 },
    );
  }

  if (featureCsv.size > MAX_CSV_SIZE_BYTES) {
    return NextResponse.json(
      {
        error:
          "This relay accepts CSV files up to 4 MB. If your feature CSV grows beyond the Vercel relay limit, upload directly to EC2 or S3.",
      },
      { status: 413 },
    );
  }

  const ec2Endpoint = getRequiredServerEnv("EC2_REALTIME_LEARNING_URL");
  if (!ec2Endpoint) {
    return NextResponse.json(
      {
        error:
          "Server configuration error: EC2_REALTIME_LEARNING_URL is not set. Configure it in your Vercel environment variables before uploading CSV files.",
      },
      { status: 500 },
    );
  }

  const upstreamFormData = new FormData();
  upstreamFormData.append("feature_csv", featureCsv, featureCsv.name);

  const headers = new Headers();
  const apiKey = getRequiredServerEnv("EC2_INFERENCE_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Server configuration error: EC2_INFERENCE_API_KEY is not set. Configure it in your Vercel environment variables before uploading CSV files.",
      },
      { status: 500 },
    );
  }

  headers.set("x-api-key", apiKey);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, getTimeoutMs());

  try {
    const upstreamResponse = await fetch(ec2Endpoint, {
      method: "POST",
      headers,
      body: upstreamFormData,
      signal: controller.signal,
      cache: "no-store",
    });

    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await upstreamResponse.json()
      : await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      return NextResponse.json(
        {
          error: extractErrorMessage(
            payload,
            `EC2 inference request failed with status ${upstreamResponse.status}.`,
          ),
        },
        { status: upstreamResponse.status },
      );
    }

    if (!isRealtimeInferenceResponse(payload)) {
      return NextResponse.json(
        {
          error:
            "EC2 responded, but the payload did not match the expected realtime inference contract.",
        },
        { status: 502 },
      );
    }

    return NextResponse.json(payload);
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The EC2 inference request timed out."
        : error instanceof Error
          ? error.message
          : "Unknown EC2 inference error.";

    return NextResponse.json(
      {
        error: `Unable to reach the EC2 inference API. ${message}`,
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
