import { NextResponse } from "next/server";

import {
  buildEc2Headers,
  extractErrorMessage,
  getEc2Endpoint,
  getTimeoutMs,
  normalizeOrBadGateway,
  readEc2Payload,
  validateFeatureCsv,
} from "@/lib/ec2-inference-relay";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      {
        error:
          "Send the uploaded CSV as multipart/form-data with the featureCsv field.",
      },
      { status: 400 },
    );
  }

  const featureCsv = formData.get("featureCsv");
  const validationError = validateFeatureCsv(featureCsv);

  if (validationError) {
    return NextResponse.json(
      { error: validationError.error },
      { status: validationError.status },
    );
  }

  const ec2Endpoint = getEc2Endpoint("/jobs");
  if (!ec2Endpoint) {
    return NextResponse.json(
      {
        error:
          "Server configuration error: EC2_REALTIME_LEARNING_URL is not set. Configure it in your Vercel environment variables before uploading CSV files.",
      },
      { status: 500 },
    );
  }

  const headers = buildEc2Headers();
  if (!headers) {
    return NextResponse.json(
      {
        error:
          "Server configuration error: EC2_INFERENCE_API_KEY is not set. Configure it in your Vercel environment variables before uploading CSV files.",
      },
      { status: 500 },
    );
  }

  const upstreamFormData = new FormData();
  upstreamFormData.append(
    "feature_csv",
    featureCsv as File,
    (featureCsv as File).name,
  );

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
    const payload = await readEc2Payload(upstreamResponse);

    if (!upstreamResponse.ok) {
      return NextResponse.json(
        {
          error: extractErrorMessage(
            payload,
            `EC2 inference job request failed with status ${upstreamResponse.status}.`,
          ),
        },
        { status: upstreamResponse.status },
      );
    }

    return normalizeOrBadGateway(payload);
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The EC2 inference job request timed out."
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
