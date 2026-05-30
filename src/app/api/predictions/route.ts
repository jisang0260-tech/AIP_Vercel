import { NextResponse } from "next/server";

import { createMockPrediction } from "@/lib/mock-prediction";

const MAX_VIDEO_SIZE_BYTES = 1024 * 1024 * 1024;
const VIDEO_FILE_PATTERN = /\.(mp4|mov|avi|mkv|webm)$/i;

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const video = formData.get("video");

  if (!(video instanceof File)) {
    return NextResponse.json(
      { error: "Attach one video file in the video field." },
      { status: 400 },
    );
  }

  if (!video.type.startsWith("video/") && !VIDEO_FILE_PATTERN.test(video.name)) {
    return NextResponse.json(
      { error: "Only video uploads are supported in this web prototype." },
      { status: 400 },
    );
  }

  if (video.size === 0) {
    return NextResponse.json(
      { error: "The selected file is empty." },
      { status: 400 },
    );
  }

  if (video.size > MAX_VIDEO_SIZE_BYTES) {
    return NextResponse.json(
      { error: "Please keep the prototype upload under 1 GB." },
      { status: 413 },
    );
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 1200);
  });

  const response = createMockPrediction({
    name: video.name,
    sizeBytes: video.size,
    mimeType: video.type || "video/mp4",
  });

  return NextResponse.json(response);
}
