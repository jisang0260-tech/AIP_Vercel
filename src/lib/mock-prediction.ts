export const PROBABILITY_BUCKETS = [
  { label: "0-30 sec", startSec: 0, endSec: 30 },
  { label: "30-60 sec", startSec: 30, endSec: 60 },
  { label: "60-120 sec", startSec: 60, endSec: 120 },
  { label: "120-180 sec", startSec: 120, endSec: 180 },
  { label: "180-300 sec", startSec: 180, endSec: 300 },
  { label: ">300 sec", startSec: 300, endSec: null },
] as const;

export type UploadedVideo = {
  name: string;
  sizeBytes: number;
  mimeType: string;
};

export type ProbabilityBucket = {
  label: string;
  startSec: number;
  endSec: number | null;
  probability: number;
  probabilityPercent: number;
  etaStartLabel: string;
  etaEndLabel: string | null;
};

export type PredictionTelemetry = {
  busCountInside: number;
  totalWaitingTimeSec: number;
  averageWaitingTimeSec: number;
  secondsSinceLastNewBus: number;
  secondsSinceLastOutBus: number;
  gateOutEventCount: number;
};

export type PredictionPayload = {
  method: "mock_random_forest";
  bestBucketLabel: string;
  expectedDepartureInSec: number;
  predictedDepartureAt: string;
  generatedAt: string;
  buckets: ProbabilityBucket[];
  telemetry: PredictionTelemetry;
};

export type PredictionResponse = {
  requestId: string;
  status: "mock_ready";
  source: "local-vercel-mock";
  uploadedVideo: UploadedVideo;
  prediction: PredictionPayload;
  integrationNote: string;
};

type MockPredictionInput = {
  name: string;
  sizeBytes: number;
  mimeType: string;
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

function formatClock(date: Date) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function getBucketMidpoint(startSec: number, endSec: number | null) {
  return endSec === null ? startSec + 90 : (startSec + endSec) / 2;
}

export function createMockPrediction(input: MockPredictionInput): PredictionResponse {
  const seed = hashString(`${input.name}:${input.sizeBytes}:${input.mimeType}`);
  const random = createSeededRandom(seed);
  const now = new Date();
  const peakIndex = Math.floor(random() * Math.min(PROBABILITY_BUCKETS.length, 5));

  const weights = PROBABILITY_BUCKETS.map((bucket, index) => {
    const distance = Math.abs(index - peakIndex);
    const concentration = Math.exp(-distance * (0.75 + random() * 0.35));
    const jitter = 0.82 + random() * 0.44;
    const latePenalty = bucket.endSec === null ? 0.55 : 1;
    return concentration * jitter * latePenalty;
  });

  const totalWeight = weights.reduce((sum, current) => sum + current, 0);
  const expectedDepartureInSec = Math.max(
    18,
    Math.round(
      PROBABILITY_BUCKETS.reduce((sum, bucket, index) => {
        const midpoint = getBucketMidpoint(bucket.startSec, bucket.endSec);
        return sum + midpoint * (weights[index] / totalWeight);
      }, 0),
    ),
  );

  const predictedDeparture = new Date(now.getTime() + expectedDepartureInSec * 1000);
  const buckets = PROBABILITY_BUCKETS.map((bucket, index) => {
    const probability = weights[index] / totalWeight;
    const etaStart = new Date(now.getTime() + bucket.startSec * 1000);
    const etaEnd =
      bucket.endSec === null
        ? null
        : new Date(now.getTime() + bucket.endSec * 1000);

    return {
      label: bucket.label,
      startSec: bucket.startSec,
      endSec: bucket.endSec,
      probability,
      probabilityPercent: Number((probability * 100).toFixed(1)),
      etaStartLabel: formatClock(etaStart),
      etaEndLabel: etaEnd ? formatClock(etaEnd) : null,
    };
  });

  const bestBucket = buckets.reduce((best, current) =>
    current.probability > best.probability ? current : best,
  );
  const busCountInside = 1 + Math.floor(random() * 4);
  const totalWaitingTimeSec = 70 + Math.round(random() * 480);
  const secondsSinceLastOutBus = 12 + Math.round(random() * 150);

  return {
    requestId: `mock-${seed.toString(36)}`,
    status: "mock_ready",
    source: "local-vercel-mock",
    uploadedVideo: {
      name: input.name,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
    },
    prediction: {
      method: "mock_random_forest",
      bestBucketLabel: bestBucket.label,
      expectedDepartureInSec,
      predictedDepartureAt: formatClock(predictedDeparture),
      generatedAt: now.toISOString(),
      buckets,
      telemetry: {
        busCountInside,
        totalWaitingTimeSec,
        averageWaitingTimeSec: Math.max(
          18,
          Math.round(totalWaitingTimeSec / busCountInside),
        ),
        secondsSinceLastNewBus: 20 + Math.round(random() * 210),
        secondsSinceLastOutBus,
        gateOutEventCount: secondsSinceLastOutBus < 45 ? 1 : 0,
      },
    },
    integrationNote:
      "The current route returns local mock probabilities. Replace it with an EC2 request when the inference endpoint is ready.",
  };
}
