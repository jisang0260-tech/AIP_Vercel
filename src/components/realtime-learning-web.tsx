"use client";

import { useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  CircleDashed,
  CloudCog,
  Clock3,
  Database,
  FileSpreadsheet,
  LoaderCircle,
  RefreshCw,
  ScanLine,
  Trash2,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import type {
  ProgressivePoint,
  RealtimeInferenceResponse,
} from "@/lib/inference-contract";
import { isRealtimeInferenceResponse } from "@/lib/inference-contract";

const PIPELINE_STEPS = [
  {
    label: "CSV 준비",
    description: "브라우저가 feature CSV 업로드를 준비합니다.",
  },
  {
    label: "Vercel 전달",
    description: "Next.js API route가 CSV를 검증하고 EC2로 넘깁니다.",
  },
  {
    label: "실시간 추론",
    description: "EC2가 realtime_departure_learning.py를 실행합니다.",
  },
  {
    label: "진행 데이터 수신",
    description: "진행 중 생성되는 예측 포인트를 계속 받아옵니다.",
  },
  {
    label: "그래프 완료",
    description: "최종 버킷 확률과 추세 그래프를 표시합니다.",
  },
] as const;

type ChartMarker = {
  x: number;
  y: number;
  value: number;
  highlighted: boolean;
  point: ProgressivePoint;
  index: number;
};

type ProbabilityBandKey =
  | "probabilityUpTo120Percent"
  | "probability120To300Percent"
  | "probabilityOver300Percent";

type EvaluatedErrorPoint = ProgressivePoint & {
  actualTimeUntilDepartureSec: number;
  predictionErrorSec: number;
  absoluteErrorSec: number;
};

const CHART_WIDTH = 720;
const CHART_HEIGHT = 360;
const PROBABILITY_CHART_HEIGHT = 260;
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_FAILURES = 5;

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSeconds(seconds: number) {
  const roundedSeconds = Math.max(0, Math.round(seconds));

  if (roundedSeconds < 60) {
    return `${roundedSeconds} sec`;
  }

  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return `${minutes} min ${remainingSeconds} sec`;
}

function formatSignedSeconds(seconds: number) {
  const sign = seconds > 0 ? "+" : seconds < 0 ? "-" : "";
  return `${sign}${formatSeconds(Math.abs(seconds))}`;
}

function formatMinuteAxisLabel(seconds: number) {
  const minutes = Math.max(0, seconds) / 60;

  if (minutes >= 10) {
    return `${Math.round(minutes)} min`;
  }

  return `${minutes.toFixed(1)} min`;
}

function isEvaluatedErrorPoint(
  point: ProgressivePoint,
): point is EvaluatedErrorPoint {
  return (
    typeof point.actualTimeUntilDepartureSec === "number" &&
    typeof point.predictionErrorSec === "number" &&
    typeof point.absoluteErrorSec === "number" &&
    Number.isFinite(point.actualTimeUntilDepartureSec) &&
    Number.isFinite(point.predictionErrorSec) &&
    Number.isFinite(point.absoluteErrorSec)
  );
}

function sampleProgressivePoints(points: ProgressivePoint[], maxPoints = 72) {
  if (points.length <= maxPoints) {
    return points;
  }

  const selectedIndexes = new Set<number>([0, points.length - 1]);

  points.forEach((point, index) => {
    if (point.currentGateOutEvent > 0) {
      selectedIndexes.add(index);
    }
  });

  const remainingIndexes = points
    .map((_, index) => index)
    .filter((index) => !selectedIndexes.has(index));
  const remainingSlots = Math.max(0, maxPoints - selectedIndexes.size);

  if (remainingSlots > 0 && remainingIndexes.length > 0) {
    const step =
      remainingSlots === 1
        ? 0
        : (remainingIndexes.length - 1) / (remainingSlots - 1);

    for (let sampleIndex = 0; sampleIndex < remainingSlots; sampleIndex += 1) {
      selectedIndexes.add(remainingIndexes[Math.round(sampleIndex * step)]);
    }
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => points[index]);
}

function median(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middleIndex];
  }

  return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
}

function buildAreaPath(
  markers: ChartMarker[],
  width: number,
  padding: { left: number; right: number },
  baselineY: number,
) {
  if (markers.length === 0) {
    return "";
  }

  return `M ${padding.left} ${baselineY} L ${markers
    .map((marker) => `${marker.x.toFixed(2)} ${marker.y.toFixed(2)}`)
    .join(" L ")} L ${width - padding.right} ${baselineY} Z`;
}

function buildSvgLine(
  points: ProgressivePoint[],
  width: number,
  height: number,
) {
  const padding = { top: 18, right: 18, bottom: 34, left: 18 };
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const baselineY = height - padding.bottom;

  if (points.length === 0) {
    return {
      path: "",
      markers: [] as ChartMarker[],
      padding,
      plotWidth,
      plotHeight,
      baselineY,
      minTime: 0,
      maxTime: 0,
      minValue: 0,
      maxValue: 0,
    };
  }

  const values = points.map((point) => point.expectedDepartureInSec);
  const minTime = Math.min(...points.map((point) => point.currentTimeSecond));
  const maxTime = Math.max(...points.map((point) => point.currentTimeSecond));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = Math.max(1, maxValue - minValue);
  const pointRange = Math.max(1, points.length - 1);

  const markers = points.map((point, index) => {
    const x =
      padding.left +
      (index / pointRange) * plotWidth;
    const y =
      padding.top +
      (1 - (point.expectedDepartureInSec - minValue) / valueRange) * plotHeight;

    return {
      x,
      y,
      value: point.expectedDepartureInSec,
      highlighted: point.currentGateOutEvent > 0,
      point,
      index,
    };
  });

  const path = markers
    .map((marker, index) =>
      `${index === 0 ? "M" : "L"} ${marker.x.toFixed(2)} ${marker.y.toFixed(2)}`,
    )
    .join(" ");

  return {
    path,
    markers,
    padding,
    plotWidth,
    plotHeight,
    baselineY,
    minTime,
    maxTime,
    minValue,
    maxValue,
  };
}

function buildErrorLine(
  points: EvaluatedErrorPoint[],
  width: number,
  height: number,
) {
  const padding = { top: 18, right: 18, bottom: 34, left: 18 };
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const baselineY = height - padding.bottom;

  if (points.length === 0) {
    return {
      path: "",
      markers: [] as ChartMarker[],
      padding,
      plotWidth,
      plotHeight,
      baselineY,
      minTime: 0,
      maxTime: 0,
      minValue: 0,
      maxValue: 0,
    };
  }

  const values = points.map((point) => point.absoluteErrorSec);
  const minTime = Math.min(...points.map((point) => point.currentTimeSecond));
  const maxTime = Math.max(...points.map((point) => point.currentTimeSecond));
  const minValue = 0;
  const maxValue = Math.max(1, ...values);
  const valueRange = Math.max(1, maxValue - minValue);
  const pointRange = Math.max(1, points.length - 1);

  const markers = points.map((point, index) => {
    const x = padding.left + (index / pointRange) * plotWidth;
    const y =
      padding.top +
      (1 - (point.absoluteErrorSec - minValue) / valueRange) * plotHeight;

    return {
      x,
      y,
      value: point.absoluteErrorSec,
      highlighted: point.currentGateOutEvent > 0,
      point,
      index,
    };
  });

  const path = markers
    .map((marker, index) =>
      `${index === 0 ? "M" : "L"} ${marker.x.toFixed(2)} ${marker.y.toFixed(2)}`,
    )
    .join(" ");

  return {
    path,
    markers,
    padding,
    plotWidth,
    plotHeight,
    baselineY,
    minTime,
    maxTime,
    minValue,
    maxValue,
  };
}

function buildProbabilityBandLine(
  points: ProgressivePoint[],
  width: number,
  height: number,
  key: ProbabilityBandKey,
) {
  const availablePoints = points.filter(
    (point): point is ProgressivePoint & Record<ProbabilityBandKey, number> =>
      typeof point[key] === "number" && Number.isFinite(point[key]),
  );
  const padding = { top: 18, right: 18, bottom: 34, left: 18 };
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const baselineY = height - padding.bottom;

  if (availablePoints.length === 0) {
    return {
      path: "",
      markers: [] as ChartMarker[],
      padding,
      plotWidth,
      plotHeight,
      baselineY,
      minTime: 0,
      maxTime: 0,
      minValue: 0,
      maxValue: 100,
    };
  }

  const minTime = Math.min(...availablePoints.map((point) => point.currentTimeSecond));
  const maxTime = Math.max(...availablePoints.map((point) => point.currentTimeSecond));
  const minValue = 0;
  const maxValue = 100;
  const valueRange = maxValue - minValue;
  const pointRange = Math.max(1, availablePoints.length - 1);

  const markers = availablePoints.map((point, index) => {
    const value = point[key];
    const x =
      padding.left +
      (index / pointRange) * plotWidth;
    const y = padding.top + (1 - value / valueRange) * plotHeight;

    return {
      x,
      y,
      value,
      highlighted: point.currentGateOutEvent > 0,
      point,
      index,
    } satisfies ChartMarker;
  });

  const path = markers
    .map((marker, index) =>
      `${index === 0 ? "M" : "L"} ${marker.x.toFixed(2)} ${marker.y.toFixed(2)}`,
    )
    .join(" ");

  return {
    path,
    markers,
    padding,
    plotWidth,
    plotHeight,
    baselineY,
    minTime,
    maxTime,
    minValue,
    maxValue,
  };
}

function buildTimeTicks(
  minTime: number,
  maxTime: number,
  width: number,
  padding: { left: number; right: number },
  count = 5,
) {
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const timeRange = Math.max(1, maxTime - minTime);

  return Array.from({ length: count }, (_, index) => {
    const ratio = count === 1 ? 0 : index / (count - 1);
    const x = padding.left + ratio * plotWidth;
    const timeSecond = minTime + ratio * timeRange;

    return {
      x,
      label: formatMinuteAxisLabel(timeSecond - minTime),
    };
  });
}

function resolveTimeDomain(points: ProgressivePoint[]) {
  if (points.length === 0) {
    return {
      minTime: 0,
      maxTime: 0,
    };
  }

  const times = points.map((point) => point.currentTimeSecond);
  return {
    minTime: Math.min(...times),
    maxTime: Math.max(...times),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getRunProgress(payload: RealtimeInferenceResponse) {
  const totalRows = Math.max(1, payload.uploadedCsv.rowCount);
  const processedRows = Math.max(0, payload.summary.processedRows);
  const ratio = Math.min(1, processedRows / totalRows);

  if (payload.status === "completed") {
    return 100;
  }

  return Math.min(96, Math.max(10, 10 + ratio * 86));
}

export function RealtimeLearningWeb() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [prediction, setPrediction] = useState<RealtimeInferenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollNotice, setPollNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progressValue, setProgressValue] = useState(0);
  const [activeStep, setActiveStep] = useState(0);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
  const activeRunIdRef = useRef<string | null>(null);

  const statusTone = useMemo(() => {
    if (error) {
      return "destructive" as const;
    }
    if (prediction?.status === "completed") {
      return "default" as const;
    }
    if (isSubmitting || prediction?.status === "queued" || prediction?.status === "running") {
      return "secondary" as const;
    }
    return "outline" as const;
  }, [error, isSubmitting, prediction]);
  const isInferenceRunning =
    isSubmitting || prediction?.status === "queued" || prediction?.status === "running";

  const sampledPoints = useMemo(
    () => sampleProgressivePoints(prediction?.progressivePoints ?? []),
    [prediction],
  );
  const chartTimeDomain = useMemo(
    () => resolveTimeDomain(prediction?.progressivePoints ?? []),
    [prediction],
  );
  const lineChart = useMemo(
    () => buildSvgLine(sampledPoints, CHART_WIDTH, CHART_HEIGHT),
    [sampledPoints],
  );
  const timeTicks = useMemo(
    () =>
      buildTimeTicks(
        chartTimeDomain.minTime,
        chartTimeDomain.maxTime,
        CHART_WIDTH,
        lineChart.padding,
      ),
    [chartTimeDomain.maxTime, chartTimeDomain.minTime, lineChart.padding],
  );
  const areaPath = useMemo(() => {
    return buildAreaPath(
      lineChart.markers,
      CHART_WIDTH,
      lineChart.padding,
      lineChart.baselineY,
    );
  }, [lineChart.baselineY, lineChart.markers, lineChart.padding]);
  const hoveredMarker =
    hoveredPointIndex === null ? null : lineChart.markers[hoveredPointIndex] ?? null;
  const hoveredPoint = hoveredMarker?.point ?? null;
  const tooltipPosition = hoveredMarker
    ? {
        left: `${Math.min(92, Math.max(8, (hoveredMarker.x / CHART_WIDTH) * 100))}%`,
        top: `${Math.min(84, Math.max(14, (hoveredMarker.y / CHART_HEIGHT) * 100))}%`,
      }
    : null;
  const gateOutMarkerCount = useMemo(
    () =>
      (prediction?.progressivePoints ?? []).filter(
        (point) => point.currentGateOutEvent > 0,
      ).length,
    [prediction],
  );
  const evaluatedErrorPoints = useMemo(
    () => (prediction?.progressivePoints ?? []).filter(isEvaluatedErrorPoint),
    [prediction],
  );
  const sampledErrorPoints = useMemo(
    () => sampleProgressivePoints(evaluatedErrorPoints, 96) as EvaluatedErrorPoint[],
    [evaluatedErrorPoints],
  );
  const errorLineChart = useMemo(
    () => buildErrorLine(sampledErrorPoints, CHART_WIDTH, PROBABILITY_CHART_HEIGHT),
    [sampledErrorPoints],
  );
  const errorAreaPath = useMemo(() => {
    return buildAreaPath(
      errorLineChart.markers,
      CHART_WIDTH,
      errorLineChart.padding,
      errorLineChart.baselineY,
    );
  }, [errorLineChart.baselineY, errorLineChart.markers, errorLineChart.padding]);
  const errorTimeTicks = useMemo(
    () =>
      buildTimeTicks(
        errorLineChart.minTime,
        errorLineChart.maxTime,
        CHART_WIDTH,
        errorLineChart.padding,
      ),
    [errorLineChart.maxTime, errorLineChart.minTime, errorLineChart.padding],
  );
  const errorStats = useMemo(() => {
    if (evaluatedErrorPoints.length === 0) {
      return null;
    }

    const absoluteErrors = evaluatedErrorPoints.map(
      (point) => point.absoluteErrorSec,
    );
    const signedErrors = evaluatedErrorPoints.map(
      (point) => point.predictionErrorSec,
    );
    const meanAbsoluteError =
      absoluteErrors.reduce((sum, value) => sum + value, 0) /
      absoluteErrors.length;
    const meanSignedError =
      signedErrors.reduce((sum, value) => sum + value, 0) / signedErrors.length;

    return {
      rows: evaluatedErrorPoints.length,
      meanAbsoluteError,
      medianAbsoluteError: median(absoluteErrors),
      meanSignedError,
    };
  }, [evaluatedErrorPoints]);
  const groupedProbabilityCharts = useMemo(() => {
    const charts = [
      {
        key: "probabilityUpTo120Percent" as const,
        title: "0-120초 확률",
        description: "0-30 + 30-60 + 60-120초",
        toneClass: "text-emerald-600",
        gradientId: "probability-band-under-120",
      },
      {
        key: "probability120To300Percent" as const,
        title: "120-300초 확률",
        description: "120-180 + 180-300초",
        toneClass: "text-amber-600",
        gradientId: "probability-band-120-300",
      },
      {
        key: "probabilityOver300Percent" as const,
        title: "300초 초과 확률",
        description: "300-600 + 600초 초과",
        toneClass: "text-fuchsia-600",
        gradientId: "probability-band-over-300",
      },
    ];

    return charts.map((config) => {
      const chart = buildProbabilityBandLine(
        sampledPoints,
        CHART_WIDTH,
        PROBABILITY_CHART_HEIGHT,
        config.key,
      );

      return {
        ...config,
        chart,
        areaPath: buildAreaPath(
          chart.markers,
          CHART_WIDTH,
          chart.padding,
          chart.baselineY,
        ),
        latestValue: chart.markers.at(-1)?.value ?? null,
        hasData: chart.markers.length > 0,
      };
    });
  }, [sampledPoints]);
  const hasGroupedProbabilityCharts = groupedProbabilityCharts.some(
    (chart) => chart.hasData,
  );

  async function handleUpload() {
    if (!selectedFile) {
      return;
    }

    const runId = crypto.randomUUID();
    activeRunIdRef.current = runId;
    setError(null);
    setPollNotice(null);
    setPrediction(null);
    setIsSubmitting(true);
    setProgressValue(8);
    setActiveStep(0);
    setHoveredPointIndex(null);

    try {
      const formData = new FormData();
      formData.append("featureCsv", selectedFile);

      const response = await fetch("/api/predictions/jobs", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as
        | RealtimeInferenceResponse
        | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "Failed to prepare a probability response.",
        );
      }

      if (!isRealtimeInferenceResponse(payload)) {
        throw new Error("The prediction response did not match the expected contract.");
      }

      setPrediction(payload);
      setPollNotice(null);
      setProgressValue(getRunProgress(payload));
      setActiveStep(payload.progressivePoints.length > 0 ? 2 : 1);

      let latestPayload = payload;
      let consecutivePollFailures = 0;

      while (
        activeRunIdRef.current === runId &&
        latestPayload.status !== "completed"
      ) {
        if (latestPayload.status === "failed") {
          throw new Error(latestPayload.error ?? "EC2 inference job failed.");
        }

        await sleep(POLL_INTERVAL_MS);

        const jobId = latestPayload.jobId ?? latestPayload.requestId;
        try {
          const pollResponse = await fetch(
            `/api/predictions/jobs/${encodeURIComponent(jobId)}`,
            { cache: "no-store" },
          );
          const pollPayload = (await pollResponse.json()) as
            | RealtimeInferenceResponse
            | { error?: string };

          if (!pollResponse.ok) {
            throw new Error(
              "error" in pollPayload && pollPayload.error
                ? pollPayload.error
                : "Failed to poll realtime inference progress.",
            );
          }

          if (!isRealtimeInferenceResponse(pollPayload)) {
            throw new Error("The progress response did not match the expected contract.");
          }

          consecutivePollFailures = 0;
          latestPayload = pollPayload;
          setPollNotice(null);
          setPrediction(pollPayload);
          setProgressValue(getRunProgress(pollPayload));
          setActiveStep(
            pollPayload.status === "completed"
              ? PIPELINE_STEPS.length - 1
              : pollPayload.progressivePoints.length > 0
                ? 3
                : 2,
          );
        } catch (pollError) {
          consecutivePollFailures += 1;
          setPollNotice(
            latestPayload.progressivePoints.length > 0
              ? "EC2 응답이 잠시 끊겨서 다시 기다리는 중입니다."
              : "EC2 잡을 기다리는 중입니다.",
          );

          if (consecutivePollFailures >= MAX_POLL_FAILURES) {
            throw new Error(
              pollError instanceof Error
                ? `EC2 응답을 계속 받지 못했습니다. ${pollError.message}`
                : "EC2 응답을 계속 받지 못했습니다.",
            );
          }
        }
      }

      if (activeRunIdRef.current === runId) {
        setPollNotice(null);
        setProgressValue(100);
        setActiveStep(PIPELINE_STEPS.length - 1);
      }
    } catch (uploadError) {
      setPollNotice(null);
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Upload failed. Please try again.",
      );
      setProgressValue(0);
      setActiveStep(0);
    } finally {
      if (activeRunIdRef.current === runId) {
        activeRunIdRef.current = null;
        setIsSubmitting(false);
      }
    }
  }

  function handleVideoSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    activeRunIdRef.current = null;
    setSelectedFile(file);
    setPrediction(null);
    setError(null);
    setPollNotice(null);
    setIsSubmitting(false);
    setProgressValue(file ? 6 : 0);
    setActiveStep(0);
    setHoveredPointIndex(null);
  }

  function resetSelection() {
    activeRunIdRef.current = null;
    setSelectedFile(null);
    setPrediction(null);
    setError(null);
    setPollNotice(null);
    setIsSubmitting(false);
    setProgressValue(0);
    setActiveStep(0);
    setHoveredPointIndex(null);
  }

  return (
    <main className="mx-auto flex min-w-0 w-full max-w-[1500px] flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
      <section className="grid min-w-0 gap-5 border-b border-border/80 pb-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <div className="min-w-0 space-y-4">
          <Badge variant="outline" className="gap-1.5 border-primary/30 bg-primary/10 text-primary">
            <ScanLine className="size-3.5" />
            실시간 학습 웹
          </Badge>
          <div className="space-y-2">
            <h1 className="max-w-2xl break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl md:text-4xl">
              CSV를 넣으면 EC2 추론 진행 상황을 그래프로 바로 확인합니다.
            </h1>
            <p className="max-w-3xl break-words text-sm leading-6 text-muted-foreground md:text-base">
              AIP BUS YOLO feature CSV를 Vercel 웹에서 업로드하면 EC2가
              실시간 학습 스크립트를 돌리고, 웹은 진행 중인 예측 포인트를
              계속 받아 그래프에 누적해서 보여줍니다.
            </p>
          </div>
        </div>

        <div className="grid min-w-0 gap-3 text-sm text-muted-foreground sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          <div className="min-w-0 rounded-lg border border-border/80 bg-card/65 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-foreground">
              <FileSpreadsheet className="size-4 text-primary" />
              Feature CSV
            </div>
            <p className="mt-2 leading-6">
              bus YOLO가 만든 `*_vehicle_counts.csv` 파일을 넣습니다.
            </p>
          </div>
          <div className="min-w-0 rounded-lg border border-border/80 bg-card/65 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-foreground">
              <BarChart3 className="size-4 text-primary" />
              실시간 그래프
            </div>
            <p className="mt-2 leading-6">
              row가 처리될 때마다 예측 변화가 누적됩니다.
            </p>
          </div>
          <div className="min-w-0 rounded-lg border border-border/80 bg-card/65 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-foreground">
              <CloudCog className="size-4 text-primary" />
              EC2 연결
            </div>
            <p className="mt-2 leading-6">
              브라우저는 Next.js API를 통해서만 EC2와 통신합니다.
            </p>
          </div>
        </div>
      </section>

      <section className="grid min-w-0 flex-1 gap-5 py-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="min-w-0 border-border/80 bg-card/78 shadow-sm">
          <CardHeader className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-xl">CSV 업로드</CardTitle>
                <CardDescription>
                  feature CSV 하나를 선택해서 EC2 실시간 추론 job으로 보냅니다.
                </CardDescription>
              </div>
              <Badge variant="outline" className="gap-1.5">
                <Upload className="size-3.5" />
                EC2 전달
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <label
              htmlFor="csv-upload"
              className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-primary/35 bg-primary/6 px-4 py-5 text-center transition-colors hover:border-primary/55 hover:bg-primary/10"
            >
              <div className="rounded-full border border-primary/25 bg-background/70 p-2.5">
                <FileSpreadsheet className="size-5 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  CSV 선택
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  `*_vehicle_counts.csv` 파일 1개
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-full border border-border/80 px-2.5 py-1">
                  .csv
                </span>
              </div>
            </label>

            <input
              id="csv-upload"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleVideoSelect}
            />

            <div className="grid gap-3 text-sm">
              <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                <div className="text-muted-foreground">선택한 파일</div>
                <div className="mt-2 truncate font-medium text-foreground">
                  {selectedFile ? selectedFile.name : "아직 없음"}
                </div>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                <div className="text-muted-foreground">크기</div>
                <div className="mt-2 font-medium text-foreground">
                  {selectedFile ? formatFileSize(selectedFile.size) : "-"}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleUpload} disabled={!selectedFile || isSubmitting}>
                {isSubmitting ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    EC2 처리 중
                  </>
                ) : (
                  <>
                    <Upload />
                    업로드 시작
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={resetSelection}
                disabled={!selectedFile && !prediction && !error}
              >
                <Trash2 />
                초기화
              </Button>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/35 px-4 py-3 text-sm leading-6 text-muted-foreground">
              업로드 후에는 job을 만들고 1초 간격으로 진행 포인트를 받아와
              그래프에 바로 반영합니다.
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 border-border/80 bg-card/78 shadow-sm">
          <CardHeader className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-xl">실시간 예측 그래프</CardTitle>
                <CardDescription>
                  EC2가 처리한 row가 들어오는 대로 그래프를 계속 업데이트합니다.
                </CardDescription>
              </div>
              <Badge variant={statusTone} className="gap-1.5">
                {prediction?.status === "completed" ? (
                  <CheckCircle2 className="size-3.5" />
                ) : isInferenceRunning ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : error ? (
                  <Activity className="size-3.5" />
                ) : (
                  <CircleDashed className="size-3.5" />
                )}
                {prediction?.status === "completed"
                  ? "Probability ready"
                  : isInferenceRunning
                    ? "실시간 수신 중"
                    : error
                      ? "재시도 필요"
                      : "대기 중"}
              </Badge>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>처리 진행률</span>
                <span>{Math.round(progressValue)}%</span>
              </div>
              <Progress value={progressValue} className="h-2.5" />
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              {PIPELINE_STEPS.map((step, index) => {
                const isComplete =
                  prediction?.status === "completed" || index < activeStep;
                const isActive =
                  prediction?.status !== "completed" &&
                  isInferenceRunning &&
                  index === activeStep;

                return (
                  <div
                    key={step.label}
                    className="flex items-start gap-3 rounded-lg border border-border/70 bg-background/65 px-4 py-3"
                  >
                    <div className="mt-0.5">
                      {isComplete ? (
                        <CheckCircle2 className="size-4 text-primary" />
                      ) : isActive ? (
                        <LoaderCircle className="size-4 animate-spin text-primary" />
                      ) : (
                        <CircleDashed className="size-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="text-sm font-medium text-foreground">
                        {step.label}
                      </div>
                      <div className="text-sm leading-6 text-muted-foreground">
                        {step.description}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <Separator />

            {error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            {!error && pollNotice ? (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                {pollNotice}
              </div>
            ) : null}

            {prediction ? (
              <div className="space-y-6">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Clock3 className="size-4 text-primary" />
                      예상 출발까지
                    </div>
                    <div className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
                      {prediction.summary.processedRows > 0
                        ? formatSeconds(prediction.summary.expectedDepartureInSec)
                        : "대기 중"}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {prediction.summary.predictedDepartureAt
                        ? `예상 시각 ${prediction.summary.predictedDepartureAt}`
                        : "EC2 job 시작 중"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <BarChart3 className="size-4 text-primary" />
                      최우선 버킷
                    </div>
                    <div className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                      {prediction.summary.bestBucketLabel || "row 수집 중"}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      상태: {prediction.source} / {prediction.status}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Database className="size-4 text-primary" />
                      ROI out 이벤트
                    </div>
                    <div className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
                      {prediction.summary.gateOutEvents}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      그래프의 파란 마커
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <RefreshCw className="size-4 text-primary" />
                      재학습 횟수
                    </div>
                    <div className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
                      {prediction.summary.retrainCount}
                    </div>
                    <p className="mt-2 truncate text-sm leading-6 text-muted-foreground">
                      {prediction.summary.activeModelPath || "base model / not reported"}
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-foreground">
                      시간 흐름별 예상 출발 추세
                    </div>
                    <div className="text-xs text-muted-foreground">
                      점 위에 올리면 해당 시점 예측을 확인할 수 있습니다
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="relative">
                      {lineChart.markers.length === 0 ? (
                        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/70 text-sm text-muted-foreground">
                          EC2에서 첫 진행 포인트를 받는 중입니다
                        </div>
                      ) : null}
                      {hoveredPoint && tooltipPosition ? (
                        <div
                          className="pointer-events-none absolute z-10 w-52 -translate-x-1/2 -translate-y-[calc(100%+0.75rem)] rounded-lg border border-border/80 bg-popover/96 px-3 py-2 text-left shadow-lg backdrop-blur-sm"
                          style={tooltipPosition}
                        >
                          <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                            예상 출발까지
                          </div>
                          <div className="mt-1 text-sm font-semibold text-foreground">
                            {formatSeconds(hoveredPoint.expectedDepartureInSec)}
                          </div>
                          <div className="mt-2 text-xs leading-5 text-muted-foreground">
                            현재 시각 {hoveredPoint.currentTimeLabel}
                          </div>
                          <div className="text-xs leading-5 text-muted-foreground">
                            최우선 버킷 {hoveredPoint.topBucket} ({hoveredPoint.topBucketProbabilityPercent}%)
                          </div>
                          {hoveredPoint.currentGateOutEvent > 0 ? (
                            <div className="mt-2 inline-flex items-center gap-2 text-xs font-medium text-sky-600">
                              <span className="size-2 rounded-full bg-sky-500" />
                              ROI out 감지
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      <svg
                        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                        preserveAspectRatio="none"
                        className="h-64 w-full"
                        role="img"
                        aria-label="시간 흐름별 예상 출발 추세 그래프"
                      >
                        <defs>
                          <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
                            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        {timeTicks.map((tick) => (
                          <line
                            key={`tick-${tick.x}`}
                            x1={tick.x}
                            x2={tick.x}
                            y1={lineChart.padding.top}
                            y2={lineChart.baselineY}
                            stroke="currentColor"
                            strokeOpacity="0.08"
                            strokeDasharray="4 6"
                            className="text-foreground"
                          />
                        ))}
                        <line
                          x1={lineChart.padding.left}
                          x2={CHART_WIDTH - lineChart.padding.right}
                          y1={lineChart.baselineY}
                          y2={lineChart.baselineY}
                          stroke="currentColor"
                          strokeOpacity="0.18"
                          className="text-foreground"
                        />
                        {areaPath ? (
                          <path
                            d={areaPath}
                            fill="url(#trend-fill)"
                            className="text-primary"
                          />
                        ) : null}
                        <path
                          d={lineChart.path}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          className="text-primary"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                        {lineChart.markers.map((marker) => (
                          <circle
                            key={`${marker.index}-${marker.x}`}
                            cx={marker.x}
                            cy={marker.y}
                            r={marker.highlighted ? 5.2 : 3.2}
                            tabIndex={0}
                            aria-label={`${marker.point.currentTimeLabel}, 예상 출발까지 ${formatSeconds(marker.point.expectedDepartureInSec)}`}
                            onMouseEnter={() => setHoveredPointIndex(marker.index)}
                            onFocus={() => setHoveredPointIndex(marker.index)}
                            onMouseLeave={() => setHoveredPointIndex(null)}
                            onBlur={() => setHoveredPointIndex(null)}
                            className={
                              marker.highlighted
                                ? "cursor-pointer fill-sky-500 stroke-background stroke-[1.5]"
                                : "cursor-pointer fill-primary/85"
                            }
                          />
                        ))}
                      </svg>

                      <div className="relative mt-4 h-12">
                        {timeTicks.map((tick) => (
                          <div
                            key={tick.label + tick.x}
                            className="absolute top-0 -translate-x-1/2 text-[11px] text-muted-foreground"
                            style={{ left: `${(tick.x / CHART_WIDTH) * 100}%` }}
                          >
                            {tick.label}
                          </div>
                        ))}
                        <div className="absolute bottom-0 left-0 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-2">
                            <span className="size-2 rounded-full bg-sky-500" />
                            ROI out 마커 ({gateOutMarkerCount})
                          </span>
                          <span>
                            범위: {formatSeconds(lineChart.minValue)} - {formatSeconds(lineChart.maxValue)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-foreground">
                      ROI 기준 예측 오차 추세
                    </div>
                    {errorStats ? (
                      <div className="text-xs text-muted-foreground">
                        평가 row {errorStats.rows.toLocaleString()}개
                      </div>
                    ) : null}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-xs text-muted-foreground">평균 절대 오차</div>
                      <div className="mt-2 text-2xl font-semibold text-foreground">
                        {errorStats ? formatSeconds(errorStats.meanAbsoluteError) : "-"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-xs text-muted-foreground">중앙 절대 오차</div>
                      <div className="mt-2 text-2xl font-semibold text-foreground">
                        {errorStats ? formatSeconds(errorStats.medianAbsoluteError) : "-"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-xs text-muted-foreground">평균 예측 편향</div>
                      <div className="mt-2 text-2xl font-semibold text-foreground">
                        {errorStats ? formatSignedSeconds(errorStats.meanSignedError) : "-"}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    {errorLineChart.markers.length > 0 ? (
                      <>
                        <svg
                          viewBox={`0 0 ${CHART_WIDTH} ${PROBABILITY_CHART_HEIGHT}`}
                          preserveAspectRatio="none"
                          className="h-64 w-full"
                          role="img"
                          aria-label="ROI 이벤트 기준 예측 오차 그래프"
                        >
                          <defs>
                            <linearGradient id="error-fill" x1="0" x2="0" y1="0" y2="1">
                              <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
                              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          {errorTimeTicks.map((tick) => (
                            <line
                              key={`error-tick-${tick.x}`}
                              x1={tick.x}
                              x2={tick.x}
                              y1={errorLineChart.padding.top}
                              y2={errorLineChart.baselineY}
                              stroke="currentColor"
                              strokeOpacity="0.08"
                              strokeDasharray="4 6"
                              className="text-foreground"
                            />
                          ))}
                          <line
                            x1={errorLineChart.padding.left}
                            x2={CHART_WIDTH - errorLineChart.padding.right}
                            y1={errorLineChart.baselineY}
                            y2={errorLineChart.baselineY}
                            stroke="currentColor"
                            strokeOpacity="0.18"
                            className="text-foreground"
                          />
                          {errorAreaPath ? (
                            <path
                              d={errorAreaPath}
                              fill="url(#error-fill)"
                              className="text-rose-500"
                            />
                          ) : null}
                          <path
                            d={errorLineChart.path}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            className="text-rose-500"
                            strokeLinejoin="round"
                            strokeLinecap="round"
                          />
                          {errorLineChart.markers.map((marker) => (
                            <circle
                              key={`error-${marker.index}-${marker.x}`}
                              cx={marker.x}
                              cy={marker.y}
                              r={marker.highlighted ? 5.2 : 3.1}
                              className={
                                marker.highlighted
                                  ? "fill-sky-500 stroke-background stroke-[1.5]"
                                  : "fill-rose-500"
                              }
                            >
                              <title>
                                {`${marker.point.currentTimeLabel} - 절대 오차 ${formatSeconds(marker.value)}, 편향 ${formatSignedSeconds(marker.point.predictionErrorSec ?? 0)}, 실제 남은 시간 ${formatSeconds(marker.point.actualTimeUntilDepartureSec ?? 0)}${
                                  marker.highlighted ? " - ROI out" : ""
                                }`}
                              </title>
                            </circle>
                          ))}
                        </svg>

                        <div className="relative mt-4 h-12">
                          {errorTimeTicks.map((tick) => (
                            <div
                              key={`error-${tick.label}-${tick.x}`}
                              className="absolute top-0 -translate-x-1/2 text-[11px] text-muted-foreground"
                              style={{ left: `${(tick.x / CHART_WIDTH) * 100}%` }}
                            >
                              {tick.label}
                            </div>
                          ))}
                          <div className="absolute bottom-0 left-0 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                            <span className="flex items-center gap-2">
                              <span className="size-2 rounded-full bg-rose-500" />
                              절대 오차
                            </span>
                            <span className="flex items-center gap-2">
                              <span className="size-2 rounded-full bg-sky-500" />
                              ROI out 마커
                            </span>
                            <span>
                              최대 {formatSeconds(errorLineChart.maxValue)}
                            </span>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border/70 bg-muted/25 px-4 py-5 text-sm leading-6 text-muted-foreground">
                        ROI 이벤트가 감지되면 해당 이벤트 기준 오차가 표시됩니다.
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-sm font-medium text-foreground">
                    묶음 버킷 확률 추세
                  </div>
                  {hasGroupedProbabilityCharts ? (
                    <div className="grid gap-4 xl:grid-cols-3">
                      {groupedProbabilityCharts.map((group) => (
                        <div
                          key={group.key}
                          className="rounded-lg border border-border/70 bg-background/70 p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-medium text-foreground">{group.title}</div>
                              <div className="text-xs text-muted-foreground">
                                {group.description}
                              </div>
                            </div>
                            <div className={`text-sm font-semibold ${group.toneClass}`}>
                              {group.latestValue === null
                                ? "-"
                                : `${group.latestValue.toFixed(1)}%`}
                            </div>
                          </div>

                          {group.hasData ? (
                            <>
                              <div className="mt-4">
                                <svg
                                  viewBox={`0 0 ${CHART_WIDTH} ${PROBABILITY_CHART_HEIGHT}`}
                                  preserveAspectRatio="none"
                                  className="h-56 w-full"
                                  role="img"
                                  aria-label={`${group.title} chart`}
                                >
                                  <defs>
                                    <linearGradient
                                      id={group.gradientId}
                                      x1="0"
                                      x2="0"
                                      y1="0"
                                      y2="1"
                                    >
                                      <stop
                                        offset="0%"
                                        stopColor="currentColor"
                                        stopOpacity="0.18"
                                      />
                                      <stop
                                        offset="100%"
                                        stopColor="currentColor"
                                        stopOpacity="0"
                                      />
                                    </linearGradient>
                                  </defs>
                                  {timeTicks.map((tick) => (
                                    <line
                                      key={`${group.key}-${tick.x}`}
                                      x1={tick.x}
                                      x2={tick.x}
                                      y1={group.chart.padding.top}
                                      y2={group.chart.baselineY}
                                      stroke="currentColor"
                                      strokeOpacity="0.08"
                                      strokeDasharray="4 6"
                                      className="text-foreground"
                                    />
                                  ))}
                                  <line
                                    x1={group.chart.padding.left}
                                    x2={CHART_WIDTH - group.chart.padding.right}
                                    y1={group.chart.baselineY}
                                      y2={group.chart.baselineY}
                                    stroke="currentColor"
                                    strokeOpacity="0.18"
                                    className="text-foreground"
                                  />
                                  {group.areaPath ? (
                                    <path
                                      d={group.areaPath}
                                      fill={`url(#${group.gradientId})`}
                                      className={group.toneClass}
                                    />
                                  ) : null}
                                  <path
                                    d={group.chart.path}
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="3"
                                    className={group.toneClass}
                                    strokeLinejoin="round"
                                    strokeLinecap="round"
                                  />
                                  {group.chart.markers.map((marker) => (
                                    <circle
                                      key={`${group.key}-${marker.index}-${marker.x}`}
                                      cx={marker.x}
                                      cy={marker.y}
                                      r={marker.highlighted ? 5.2 : 3.1}
                                      className={
                                        marker.highlighted
                                          ? "fill-sky-500 stroke-background stroke-[1.5]"
                                          : `${group.toneClass} fill-current`
                                      }
                                    >
                                      <title>
                                        {`${marker.point.currentTimeLabel} - ${group.title}: ${marker.value.toFixed(2)}%${
                                          marker.highlighted ? " - ROI out" : ""
                                        }`}
                                      </title>
                                    </circle>
                                  ))}
                                </svg>
                              </div>
                              <div className="relative mt-4 h-12">
                                {timeTicks.map((tick) => (
                                  <div
                                    key={`${group.key}-${tick.label}-${tick.x}`}
                                    className="absolute top-0 -translate-x-1/2 text-[11px] text-muted-foreground"
                                    style={{ left: `${(tick.x / CHART_WIDTH) * 100}%` }}
                                  >
                                    {tick.label}
                                  </div>
                                ))}
                                <div className="absolute bottom-0 left-0 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                                  <span className="flex items-center gap-2">
                                    <span className="size-2 rounded-full bg-sky-500" />
                                    ROI out 마커
                                  </span>
                                  <span>0% - 100% 확률 스케일</span>
                                </div>
                              </div>
                            </>
                          ) : (
                            <div className="mt-4 rounded-lg border border-dashed border-border/70 bg-muted/25 px-4 py-5 text-sm leading-6 text-muted-foreground">
                              아직 이 구간의 row별 버킷 확률이 들어오지 않았습니다.
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/70 bg-background/60 px-4 py-5 text-sm leading-6 text-muted-foreground">
                      EC2가 row별 `prob_*` 값을 보내면 0-120초, 120-300초,
                      300초 초과 확률 그래프가 여기에 표시됩니다.
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="text-sm font-medium text-foreground">
                    최종 버킷 스냅샷
                  </div>
                  {prediction.finalBuckets.length ? (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {prediction.finalBuckets.map((bucket) => (
                        <div
                          key={bucket.label}
                          className="rounded-lg border border-border/70 bg-background/70 p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-medium text-foreground">{bucket.label}</div>
                              <div className="text-xs text-muted-foreground">
                                {bucket.etaStartLabel}
                                {bucket.etaEndLabel ? ` - ${bucket.etaEndLabel}` : "+"}
                              </div>
                            </div>
                            <div className="text-sm font-medium text-foreground">
                              {bucket.probabilityPercent}%
                            </div>
                          </div>
                          <div className="mt-4 flex h-36 items-end justify-center rounded-md border border-border/50 bg-muted/25 p-2">
                            <div
                              className="w-12 rounded-t-md bg-primary/85 transition-[height]"
                              style={{
                                height: `${Math.max(bucket.probabilityPercent, 4)}%`,
                              }}
                            />
                          </div>
                          <Progress value={bucket.probabilityPercent} className="mt-3 h-2" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/70 bg-background/60 px-4 py-5 text-sm leading-6 text-muted-foreground">
                      EC2 job이 끝나면 최종 버킷 확률이 표시됩니다. 그 전에도
                      진행 중인 추세 그래프는 계속 업데이트됩니다.
                    </div>
                  )}
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="text-sm font-medium text-foreground">
                    추론 실행 정보
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">업로드 CSV</div>
                      <div className="mt-2 text-base font-semibold text-foreground">
                        {prediction.uploadedCsv.name}
                      </div>
                      <div className="mt-2 text-sm text-muted-foreground">
                        {prediction.uploadedCsv.rowCount} rows / {prediction.uploadedCsv.columnCount} columns
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">감지된 컬럼</div>
                      <div className="mt-2 text-sm font-medium leading-6 text-foreground">
                        {prediction.uploadedCsv.columns.slice(0, 6).join(", ")}
                        {prediction.uploadedCsv.columns.length > 6 ? ", ..." : ""}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">최우선 버킷 신뢰도</div>
                      <div className="mt-2 text-xl font-semibold text-foreground">
                        {prediction.summary.bestBucketProbabilityPercent}%
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">생성 시각</div>
                      <div className="mt-2 text-sm font-semibold text-foreground">
                        {new Intl.DateTimeFormat("ko-KR", {
                          dateStyle: "short",
                          timeStyle: "medium",
                        }).format(new Date(prediction.summary.generatedAt))}
                      </div>
                    </div>
                  </div>
                </div>

                {prediction.notes.length ? (
                  <div className="rounded-lg border border-primary/20 bg-primary/8 px-4 py-3 text-sm leading-6 text-muted-foreground">
                    <div className="font-medium text-foreground">연동 메모</div>
                    <ul className="mt-2 space-y-1">
                      {prediction.notes.map((note) => (
                        <li key={note}>- {note}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex min-h-72 flex-col justify-center gap-3 rounded-lg border border-dashed border-border/75 bg-background/60 px-5 py-6">
                <div className="flex items-center gap-2 text-foreground">
                  <FileSpreadsheet className="size-5 text-primary" />
                  feature CSV를 기다리는 중입니다
                </div>
                <p className="max-w-md text-sm leading-6 text-muted-foreground">
                  왼쪽에서 bus YOLO feature CSV를 업로드하면 EC2에서 들어오는
                  진행 포인트와 버킷 확률을 큰 그래프로 확인할 수 있습니다.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
