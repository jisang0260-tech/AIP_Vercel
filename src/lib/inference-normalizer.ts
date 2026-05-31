import type {
  InferenceSummary,
  ProgressivePoint,
  ProbabilityBucketResult,
  RealtimeInferenceResponse,
  UploadedCsvSummary,
} from "@/lib/inference-contract";

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }

  return null;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function normalizePercent(value: number | null) {
  if (value === null) {
    return null;
  }

  const scaled = value <= 1 ? value * 100 : value;
  return Number(scaled.toFixed(2));
}

function readNullableString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : null;
    }
    if (value === null) {
      return null;
    }
  }

  return null;
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

function readArray(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return null;
}

function normalizeUploadedCsv(value: unknown): UploadedCsvSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name = readString(record, "name");
  const sizeBytes = readNumber(record, "sizeBytes", "size_bytes");
  const mimeType =
    readString(record, "mimeType", "mime_type") ?? "text/csv";
  const rowCount = readNumber(record, "rowCount", "row_count");
  const columnCount = readNumber(record, "columnCount", "column_count");
  const columns = readArray(record, "columns");

  if (
    !name ||
    sizeBytes === null ||
    rowCount === null ||
    columnCount === null ||
    !columns ||
    !columns.every((column) => typeof column === "string")
  ) {
    return null;
  }

  return {
    name,
    sizeBytes,
    mimeType,
    rowCount,
    columnCount,
    columns,
  };
}

function normalizeSummary(
  value: unknown,
  lastPoint: ProgressivePoint | null,
): InferenceSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const method = readString(record, "method");
  const bestBucketLabel = readString(
    record,
    "bestBucketLabel",
    "best_bucket_label",
  );
  const bestBucketProbabilityPercent = readNumber(
    record,
    "bestBucketProbabilityPercent",
    "best_bucket_probability_percent",
  );
  const expectedDepartureInSec = readNumber(
    record,
    "expectedDepartureInSec",
    "expected_departure_in_sec",
  );
  const predictedDepartureAt =
    readString(
    record,
    "predictedDepartureAt",
    "predicted_departure_at",
    "predicted_departure_hhmmss",
  ) ??
    lastPoint?.predictedDepartureAt ??
    null;
  const processedRows = readNumber(record, "processedRows", "processed_rows");
  const gateOutEvents = readNumber(record, "gateOutEvents", "gate_out_events");
  const retrainCount = readNumber(record, "retrainCount", "retrain_count");
  const activeModelPath = readNullableString(
    record,
    "activeModelPath",
    "active_model_path",
  );
  const generatedAt = readString(record, "generatedAt", "generated_at");

  if (
    !method ||
    !bestBucketLabel ||
    bestBucketProbabilityPercent === null ||
    expectedDepartureInSec === null ||
    !predictedDepartureAt ||
    processedRows === null ||
    gateOutEvents === null ||
    retrainCount === null ||
    !generatedAt
  ) {
    return null;
  }

  return {
    method,
    bestBucketLabel,
    bestBucketProbabilityPercent,
    expectedDepartureInSec,
    predictedDepartureAt,
    processedRows,
    gateOutEvents,
    retrainCount,
    activeModelPath,
    generatedAt,
  };
}

function normalizeFinalBuckets(
  value: unknown,
  currentTimeSecond: number,
): ProbabilityBucketResult[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const buckets = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const label = readString(record, "label", "bucket");
      const startSec = readNumber(record, "startSec", "start_sec");
      const endSec =
        readNumber(record, "endSec", "end_sec") ??
        (record.endSec === null || record.end_sec === null ? null : null);
      const probability = readNumber(record, "probability");
      const probabilityPercent = readNumber(
        record,
        "probabilityPercent",
        "probability_percent",
      );

      if (
        !label ||
        startSec === null ||
        probability === null ||
        probabilityPercent === null ||
        startSec === null
      ) {
        return null;
      }

      const etaStartLabel =
        readString(
          record,
          "etaStartLabel",
          "eta_start_label",
          "eta_start_hhmmss",
        ) ?? secondsToClock(currentTimeSecond + startSec);
      const etaEndLabel =
        readNullableString(
          record,
          "etaEndLabel",
          "eta_end_label",
          "eta_end_hhmmss",
        ) ??
        (endSec === null ? null : secondsToClock(currentTimeSecond + endSec));

      return {
        label,
        startSec,
        endSec,
        probability,
        probabilityPercent,
        etaStartLabel,
        etaEndLabel,
      } satisfies ProbabilityBucketResult;
    })
    .filter((entry): entry is ProbabilityBucketResult => entry !== null);

  return buckets.length ? buckets : null;
}

function normalizeProgressivePoints(value: unknown): ProgressivePoint[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const points = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const prefixRows = readNumber(record, "prefixRows", "prefix_rows");
      const currentRowIndex = readNumber(
        record,
        "currentRowIndex",
        "current_row_index",
      );
      const currentTimeSecond = readNumber(
        record,
        "currentTimeSecond",
        "current_time_second",
      );
      const expectedDepartureInSec = readNumber(
        record,
        "expectedDepartureInSec",
        "expected_departure_in_sec",
      );
      const topBucket = readString(record, "topBucket", "top_bucket");
      const topBucketProbabilityPercent = readNumber(
        record,
        "topBucketProbabilityPercent",
        "top_bucket_probability_percent",
      );
      const currentGateOutEvent =
        readNumber(record, "currentGateOutEvent", "current_gate_out_event") ?? 0;
      const seenGateOutEvents =
        readNumber(record, "seenGateOutEvents", "seen_gate_out_events") ?? 0;
      const prob0To30 = readNumber(record, "prob_0_30_sec", "probability_0_30_sec");
      const prob30To60 = readNumber(record, "prob_30_60_sec", "probability_30_60_sec");
      const prob60To120 = readNumber(record, "prob_60_120_sec", "probability_60_120_sec");
      const prob120To180 = readNumber(record, "prob_120_180_sec", "probability_120_180_sec");
      const prob180To300 = readNumber(record, "prob_180_300_sec", "probability_180_300_sec");
      const prob300To600 = readNumber(record, "prob_300_600_sec", "probability_300_600_sec");
      const probOver600 = readNumber(record, "prob_600_sec", "probability_600_sec");
      const probabilityUpTo120Percent =
        prob0To30 !== null || prob30To60 !== null || prob60To120 !== null
          ? normalizePercent((prob0To30 ?? 0) + (prob30To60 ?? 0) + (prob60To120 ?? 0))
          : normalizePercent(
              readNumber(
                record,
                "probabilityUpTo120Percent",
                "probability_up_to_120_percent",
              ),
            );
      const probability120To300Percent =
        prob120To180 !== null || prob180To300 !== null
          ? normalizePercent((prob120To180 ?? 0) + (prob180To300 ?? 0))
          : normalizePercent(
              readNumber(
                record,
                "probability120To300Percent",
                "probability_120_to_300_percent",
              ),
            );
      const probabilityOver300Percent =
        prob300To600 !== null || probOver600 !== null
          ? normalizePercent((prob300To600 ?? 0) + (probOver600 ?? 0))
          : normalizePercent(
              readNumber(
                record,
                "probabilityOver300Percent",
                "probability_over_300_percent",
              ),
            );

      if (
        prefixRows === null ||
        currentRowIndex === null ||
        currentTimeSecond === null ||
        expectedDepartureInSec === null ||
        !topBucket ||
        topBucketProbabilityPercent === null
      ) {
        return null;
      }

      const currentTimeLabel =
        readString(
          record,
          "currentTimeLabel",
          "current_time_label",
          "current_time_hhmmss",
        ) ?? secondsToClock(currentTimeSecond);
      const predictedDepartureAt =
        readString(
          record,
          "predictedDepartureAt",
          "predicted_departure_at",
          "predicted_departure_hhmmss",
        ) ?? secondsToClock(currentTimeSecond + expectedDepartureInSec);

      return {
        prefixRows,
        currentRowIndex,
        currentTimeSecond,
        currentTimeLabel,
        expectedDepartureInSec,
        predictedDepartureAt,
        topBucket,
        topBucketProbabilityPercent,
        currentGateOutEvent,
        seenGateOutEvents,
        ...(probabilityUpTo120Percent !== null
          ? { probabilityUpTo120Percent }
          : {}),
        ...(probability120To300Percent !== null
          ? { probability120To300Percent }
          : {}),
        ...(probabilityOver300Percent !== null
          ? { probabilityOver300Percent }
          : {}),
      } satisfies ProgressivePoint;
    })
    .filter((entry): entry is ProgressivePoint => entry !== null);

  return points.length ? points : null;
}

export function normalizeRealtimeInferenceResponse(
  value: unknown,
): RealtimeInferenceResponse | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const requestId = readString(record, "requestId", "request_id");
  const status = readString(record, "status");
  const source = readString(record, "source") ?? "ec2";
  const uploadedCsv = normalizeUploadedCsv(
    record.uploadedCsv ?? record.uploaded_csv,
  );
  const progressivePoints = normalizeProgressivePoints(
    record.progressivePoints ?? record.progressive_points,
  );
  const lastPoint = progressivePoints?.at(-1) ?? null;
  const summary = normalizeSummary(record.summary, lastPoint);
  const finalBuckets = normalizeFinalBuckets(
    record.finalBuckets ?? record.final_buckets,
    lastPoint?.currentTimeSecond ?? 0,
  );
  const notes =
    readArray(record, "notes")?.filter(
      (note): note is string => typeof note === "string",
    ) ?? [];

  if (
    !requestId ||
    status !== "completed" ||
    !uploadedCsv ||
    !summary ||
    !finalBuckets ||
    !progressivePoints
  ) {
    return null;
  }

  return {
    requestId,
    status: "completed",
    source,
    uploadedCsv,
    summary,
    finalBuckets,
    progressivePoints,
    notes,
  };
}
