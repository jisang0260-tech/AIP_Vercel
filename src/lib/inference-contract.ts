export const PROBABILITY_BUCKETS = [
  { label: "0-30 sec", startSec: 0, endSec: 30 },
  { label: "30-60 sec", startSec: 30, endSec: 60 },
  { label: "60-120 sec", startSec: 60, endSec: 120 },
  { label: "120-180 sec", startSec: 120, endSec: 180 },
  { label: "180-300 sec", startSec: 180, endSec: 300 },
  { label: "300-600 sec", startSec: 300, endSec: 600 },
  { label: ">600 sec", startSec: 600, endSec: null },
] as const;

export type UploadedCsvSummary = {
  name: string;
  sizeBytes: number;
  mimeType: string;
  rowCount: number;
  columnCount: number;
  columns: string[];
};

export type ProbabilityBucketResult = {
  label: string;
  startSec: number;
  endSec: number | null;
  probability: number;
  probabilityPercent: number;
  etaStartLabel: string;
  etaEndLabel: string | null;
};

export type ProgressivePoint = {
  prefixRows: number;
  currentRowIndex: number;
  currentTimeSecond: number;
  currentTimeLabel: string;
  expectedDepartureInSec: number;
  predictedDepartureAt: string;
  topBucket: string;
  topBucketProbabilityPercent: number;
  currentGateOutEvent: number;
  seenGateOutEvents: number;
  probabilityUpTo120Percent?: number;
  probability120To300Percent?: number;
  probabilityOver300Percent?: number;
};

export type InferenceSummary = {
  method: string;
  bestBucketLabel: string;
  bestBucketProbabilityPercent: number;
  expectedDepartureInSec: number;
  predictedDepartureAt: string;
  processedRows: number;
  gateOutEvents: number;
  retrainCount: number;
  activeModelPath: string | null;
  generatedAt: string;
};

export type RealtimeInferenceResponse = {
  requestId: string;
  jobId?: string;
  status: "queued" | "running" | "completed" | "failed";
  source: string;
  uploadedCsv: UploadedCsvSummary;
  summary: InferenceSummary;
  finalBuckets: ProbabilityBucketResult[];
  progressivePoints: ProgressivePoint[];
  error?: string | null;
  notes: string[];
};

export function isRealtimeInferenceResponse(
  value: unknown,
): value is RealtimeInferenceResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RealtimeInferenceResponse>;

  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.status === "string" &&
    ["queued", "running", "completed", "failed"].includes(candidate.status) &&
    typeof candidate.source === "string" &&
    !!candidate.uploadedCsv &&
    !!candidate.summary &&
    Array.isArray(candidate.finalBuckets) &&
    Array.isArray(candidate.progressivePoints) &&
    Array.isArray(candidate.notes)
  );
}
