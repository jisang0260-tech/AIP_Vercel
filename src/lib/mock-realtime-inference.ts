import {
  PROBABILITY_BUCKETS,
  type ProgressivePoint,
  type ProbabilityBucketResult,
  type RealtimeInferenceResponse,
} from "@/lib/inference-contract";
import {
  numericValueByHeader,
  parseCsvText,
  valueByHeader,
} from "@/lib/csv-utils";

type MockInferenceInput = {
  name: string;
  sizeBytes: number;
  mimeType: string;
  text: string;
};

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash || 1;
}

function createSeededRandom(seed: number) {
  let state = seed % 2147483647;
  if (state <= 0) {
    state += 2147483646;
  }

  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

function secondsToClock(seconds: number) {
  const normalizedSeconds = Math.max(0, Math.round(seconds)) % (24 * 3600);
  const hour = Math.floor(normalizedSeconds / 3600);
  const minute = Math.floor((normalizedSeconds % 3600) / 60);
  const second = normalizedSeconds % 60;
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:${second.toString().padStart(2, "0")}`;
}

function getBucketMidpoint(startSec: number, endSec: number | null) {
  return endSec === null ? startSec + 120 : (startSec + endSec) / 2;
}

function buildBucketResults(
  expectedDepartureInSec: number,
  currentTimeSecond: number,
  random: () => number,
) {
  const weights = PROBABILITY_BUCKETS.map((bucket) => {
    const midpoint = getBucketMidpoint(bucket.startSec, bucket.endSec);
    const distance = Math.abs(midpoint - expectedDepartureInSec);
    const spread = bucket.endSec === null ? 220 : 120;
    const concentration = Math.exp(-distance / spread);
    const jitter = 0.88 + random() * 0.28;
    return concentration * jitter;
  });

  const totalWeight = weights.reduce((sum, current) => sum + current, 0);

  return PROBABILITY_BUCKETS.map((bucket, index) => {
    const probability = weights[index] / totalWeight;
    const etaStartSecond = currentTimeSecond + bucket.startSec;
    const etaEndSecond =
      bucket.endSec === null ? null : currentTimeSecond + bucket.endSec;

    return {
      label: bucket.label,
      startSec: bucket.startSec,
      endSec: bucket.endSec,
      probability,
      probabilityPercent: Number((probability * 100).toFixed(2)),
      etaStartLabel: secondsToClock(etaStartSecond),
      etaEndLabel: etaEndSecond === null ? null : secondsToClock(etaEndSecond),
    } satisfies ProbabilityBucketResult;
  });
}

function buildProgressivePoint(
  headers: string[],
  row: string[],
  rowIndex: number,
  totalRows: number,
  gateOutEventsSeen: number,
  random: () => number,
) {
  const currentTimeSecond = numericValueByHeader(
    headers,
    row,
    "time_second",
    rowIndex + 1,
  );
  const currentTimeLabel =
    valueByHeader(headers, row, "time_hhmmss") || secondsToClock(currentTimeSecond);
  const avgWaitingTime = numericValueByHeader(headers, row, "avg_waiting_time", 40);
  const totalWaitingTime = numericValueByHeader(
    headers,
    row,
    "total_waiting_time",
    avgWaitingTime,
  );
  const busCountInside = Math.max(
    1,
    numericValueByHeader(headers, row, "bus_count_inside", 1),
  );
  const secondsSinceLastOut = numericValueByHeader(
    headers,
    row,
    "seconds_since_last_out_bus",
    60,
  );
  const progress = totalRows <= 1 ? 1 : rowIndex / (totalRows - 1);
  const trend = (1 - progress) * 80;
  const seededNoise = (random() - 0.5) * 12;
  const expectedDepartureInSec = Math.max(
    18,
    Math.round(
      avgWaitingTime * 0.65 +
        totalWaitingTime / (busCountInside * 5.5) +
        Math.min(90, secondsSinceLastOut * 0.35) +
        trend +
        seededNoise,
    ),
  );
  const bucketResults = buildBucketResults(
    expectedDepartureInSec,
    currentTimeSecond,
    random,
  );
  const topBucket = bucketResults.reduce((best, current) =>
    current.probability > best.probability ? current : best,
  );

  return {
    prefixRows: rowIndex + 1,
    currentRowIndex: rowIndex,
    currentTimeSecond: Number(currentTimeSecond.toFixed(3)),
    currentTimeLabel,
    expectedDepartureInSec,
    predictedDepartureAt: secondsToClock(currentTimeSecond + expectedDepartureInSec),
    topBucket: topBucket.label,
    topBucketProbabilityPercent: topBucket.probabilityPercent,
    currentGateOutEvent: numericValueByHeader(headers, row, "gate_out_event_count", 0)
      ? 1
      : 0,
    seenGateOutEvents: gateOutEventsSeen,
  } satisfies ProgressivePoint;
}

export function createMockRealtimeInferenceResponse({
  name,
  sizeBytes,
  mimeType,
  text,
}: MockInferenceInput): RealtimeInferenceResponse {
  const { headers, rows } = parseCsvText(text);
  const seed = hashString(`${name}:${sizeBytes}:${headers.join(",")}`);
  const random = createSeededRandom(seed);
  let seenGateOutEvents = 0;

  const progressivePoints = rows.map((row, rowIndex) => {
    if (numericValueByHeader(headers, row, "gate_out_event_count", 0) > 0) {
      seenGateOutEvents += 1;
    }

    return buildProgressivePoint(
      headers,
      row,
      rowIndex,
      rows.length,
      seenGateOutEvents,
      random,
    );
  });

  const lastPoint =
    progressivePoints.at(-1) ??
    ({
      prefixRows: 0,
      currentRowIndex: 0,
      currentTimeSecond: 0,
      currentTimeLabel: "00:00:00",
      expectedDepartureInSec: 60,
      predictedDepartureAt: "00:01:00",
      topBucket: "30-60 sec",
      topBucketProbabilityPercent: 35,
      currentGateOutEvent: 0,
      seenGateOutEvents: 0,
    } satisfies ProgressivePoint);

  const finalBuckets = buildBucketResults(
    lastPoint.expectedDepartureInSec,
    lastPoint.currentTimeSecond,
    random,
  );
  const bestBucket = finalBuckets.reduce((best, current) =>
    current.probability > best.probability ? current : best,
  );

  return {
    requestId: `fallback-${seed.toString(36)}`,
    status: "completed",
    source: "local-fallback",
    uploadedCsv: {
      name,
      sizeBytes,
      mimeType,
      rowCount: rows.length,
      columnCount: headers.length,
      columns: headers,
    },
    summary: {
      method: "local_fallback",
      bestBucketLabel: bestBucket.label,
      bestBucketProbabilityPercent: bestBucket.probabilityPercent,
      expectedDepartureInSec: lastPoint.expectedDepartureInSec,
      predictedDepartureAt: lastPoint.predictedDepartureAt,
      processedRows: rows.length,
      gateOutEvents: seenGateOutEvents,
      retrainCount: Math.floor(seenGateOutEvents / 15),
      activeModelPath:
        rows.length > 0 ? "models/realtime_departure_random_forest.joblib" : null,
      generatedAt: new Date().toISOString(),
    },
    finalBuckets,
    progressivePoints,
    notes: [
      "EC2 endpoint is not configured, so the app returned a local fallback response.",
      "Set EC2_REALTIME_LEARNING_URL to forward uploaded feature CSV files to your EC2 inference API.",
    ],
  };
}
