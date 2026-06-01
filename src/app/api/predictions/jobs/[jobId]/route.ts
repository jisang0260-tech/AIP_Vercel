import { NextResponse } from "next/server";

import {
  buildEc2Headers,
  extractErrorMessage,
  getEc2Endpoint,
  getTimeoutMs,
  normalizeOrBadGateway,
  readEc2Payload,
} from "@/lib/ec2-inference-relay";

type RouteParams = Promise<{
  jobId: string;
}>;

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  segmentData: { params: RouteParams },
) {
  const { jobId } = await segmentData.params;
  const ec2Endpoint = getEc2Endpoint(`/jobs/${encodeURIComponent(jobId)}`);

  if (!ec2Endpoint) {
    return NextResponse.json(
      {
        error:
          "Server configuration error: EC2_REALTIME_LEARNING_URL is not set. Configure it in your Vercel environment variables before polling inference jobs.",
      },
      { status: 500 },
    );
  }

  const headers = buildEc2Headers();
  if (!headers) {
    return NextResponse.json(
      {
        error:
          "Server configuration error: EC2_INFERENCE_API_KEY is not set. Configure it in your Vercel environment variables before polling inference jobs.",
      },
      { status: 500 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, getTimeoutMs());

  try {
    const upstreamResponse = await fetch(ec2Endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await readEc2Payload(upstreamResponse);

    if (!upstreamResponse.ok) {
      return NextResponse.json(
        {
          error: extractErrorMessage(
            payload,
            `EC2 inference job polling failed with status ${upstreamResponse.status}.`,
          ),
        },
        { status: upstreamResponse.status },
      );
    }

    return normalizeOrBadGateway(payload);
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The EC2 inference job polling request timed out."
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
