"use client";

import { useEffect, useMemo, useState } from "react";
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
  Table2,
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
import { parseCsvText } from "@/lib/csv-utils";
import type {
  ProgressivePoint,
  RealtimeInferenceResponse,
} from "@/lib/inference-contract";
import { isRealtimeInferenceResponse } from "@/lib/inference-contract";

const PIPELINE_STEPS = [
  {
    label: "CSV staged",
    description: "The browser has prepared the feature CSV payload.",
  },
  {
    label: "Vercel relay",
    description: "The Next.js route validates the CSV and forwards it to EC2.",
  },
  {
    label: "Realtime script",
    description: "EC2 runs realtime_departure_learning.py against the uploaded feature CSV.",
  },
  {
    label: "JSON response",
    description: "EC2 converts probability outputs into a web-friendly response payload.",
  },
  {
    label: "Dashboard ready",
    description: "The app renders summary metrics, trend graph, and bucket probabilities.",
  },
] as const;

type CsvPreview = {
  headers: string[];
  rows: string[][];
};

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

const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;

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

function formatMinuteAxisLabel(seconds: number) {
  const minutes = Math.max(0, seconds) / 60;

  if (minutes >= 10) {
    return `${Math.round(minutes)} min`;
  }

  return `${minutes.toFixed(1)} min`;
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

function buildSvgLine(points: ProgressivePoint[], width: number, height: number) {
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

  const times = points.map((point) => point.currentTimeSecond);
  const values = points.map((point) => point.expectedDepartureInSec);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const timeRange = Math.max(1, maxTime - minTime);
  const valueRange = Math.max(1, maxValue - minValue);

  const markers = points.map((point, index) => {
    const x =
      padding.left +
      ((point.currentTimeSecond - minTime) / timeRange) * plotWidth;
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

  const times = availablePoints.map((point) => point.currentTimeSecond);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeRange = Math.max(1, maxTime - minTime);
  const minValue = 0;
  const maxValue = 100;
  const valueRange = maxValue - minValue;

  const markers = availablePoints.map((point, index) => {
    const value = point[key];
    const x =
      padding.left +
      ((point.currentTimeSecond - minTime) / timeRange) * plotWidth;
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

export function RealtimeLearningWeb() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [csvPreview, setCsvPreview] = useState<CsvPreview | null>(null);
  const [prediction, setPrediction] = useState<RealtimeInferenceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progressValue, setProgressValue] = useState(0);
  const [activeStep, setActiveStep] = useState(0);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!selectedFile) {
      return undefined;
    }

    let isActive = true;

    void selectedFile
      .slice(0, 24 * 1024)
      .text()
      .then((snippet) => {
        if (!isActive) {
          return;
        }

        const { headers, rows } = parseCsvText(snippet);
        setCsvPreview({
          headers,
          rows: rows.slice(0, 5),
        });
      })
      .catch(() => {
        if (!isActive) {
          return;
        }

        setCsvPreview(null);
      });

    return () => {
      isActive = false;
    };
  }, [selectedFile]);

  const statusTone = useMemo(() => {
    if (error) {
      return "destructive" as const;
    }
    if (prediction) {
      return "default" as const;
    }
    if (isSubmitting) {
      return "secondary" as const;
    }
    return "outline" as const;
  }, [error, isSubmitting, prediction]);

  const sampledPoints = useMemo(
    () => sampleProgressivePoints(prediction?.progressivePoints ?? []),
    [prediction],
  );
  const lineChart = useMemo(
    () => buildSvgLine(sampledPoints, CHART_WIDTH, CHART_HEIGHT),
    [sampledPoints],
  );
  const timeTicks = useMemo(
    () =>
      buildTimeTicks(
        lineChart.minTime,
        lineChart.maxTime,
        CHART_WIDTH,
        lineChart.padding,
      ),
    [lineChart.maxTime, lineChart.minTime, lineChart.padding],
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
  const groupedProbabilityCharts = useMemo(() => {
    const charts = [
      {
        key: "probabilityUpTo120Percent" as const,
        title: "0-120 sec probability",
        description: "0-30 + 30-60 + 60-120 sec",
        toneClass: "text-emerald-600",
        gradientId: "probability-band-under-120",
      },
      {
        key: "probability120To300Percent" as const,
        title: "120-300 sec probability",
        description: "120-180 + 180-300 sec",
        toneClass: "text-amber-600",
        gradientId: "probability-band-120-300",
      },
      {
        key: "probabilityOver300Percent" as const,
        title: ">300 sec probability",
        description: "300-600 + >600 sec",
        toneClass: "text-fuchsia-600",
        gradientId: "probability-band-over-300",
      },
    ];

    return charts.map((config) => {
      const chart = buildProbabilityBandLine(
        sampledPoints,
        CHART_WIDTH,
        220,
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

    setError(null);
    setPrediction(null);
    setIsSubmitting(true);
    setProgressValue(8);
    setActiveStep(0);
    setHoveredPointIndex(null);

    const intervalId = window.setInterval(() => {
      setProgressValue((current) => {
        if (current >= 90) {
          return current;
        }

        const next = Math.min(current + 6 + Math.random() * 8, 90);

        if (next >= 18) {
          setActiveStep(1);
        }
        if (next >= 42) {
          setActiveStep(2);
        }
        if (next >= 74) {
          setActiveStep(3);
        }

        return next;
      });
    }, 360);

    try {
      const formData = new FormData();
      formData.append("featureCsv", selectedFile);

      const response = await fetch("/api/predictions", {
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
      setProgressValue(100);
      setActiveStep(PIPELINE_STEPS.length - 1);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Upload failed. Please try again.",
      );
      setProgressValue(0);
      setActiveStep(0);
    } finally {
      window.clearInterval(intervalId);
      setIsSubmitting(false);
    }
  }

  function handleVideoSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setCsvPreview(null);
    setPrediction(null);
    setError(null);
    setProgressValue(file ? 6 : 0);
    setActiveStep(0);
    setHoveredPointIndex(null);
  }

  function resetSelection() {
    setSelectedFile(null);
    setCsvPreview(null);
    setPrediction(null);
    setError(null);
    setProgressValue(0);
    setActiveStep(0);
    setHoveredPointIndex(null);
  }

  return (
    <main className="mx-auto flex min-w-0 w-full max-w-7xl flex-1 flex-col px-4 py-8 sm:px-6 lg:px-10">
      <section className="grid min-w-0 gap-5 border-b border-border/80 pb-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
        <div className="min-w-0 space-y-4">
          <Badge variant="outline" className="gap-1.5 border-primary/30 bg-primary/10 text-primary">
            <ScanLine className="size-3.5" />
            Realtime learning web
          </Badge>
          <div className="space-y-2">
            <h1 className="max-w-2xl break-words text-2xl font-semibold tracking-tight text-foreground sm:text-3xl md:text-4xl">
              Upload feature CSV and review realtime departure learning on the web.
            </h1>
            <p className="max-w-3xl break-words text-sm leading-6 text-muted-foreground md:text-base">
              This Vercel web surface mirrors the AIP BUS realtime-learning flow:
              accept a bus YOLO feature CSV, relay it to EC2, and render the
              returned progressive inference results as charts and bucket
              probabilities.
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
              Upload a `*_vehicle_counts.csv` file created by bus YOLO analysis.
            </p>
          </div>
          <div className="min-w-0 rounded-lg border border-border/80 bg-card/65 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-foreground">
              <BarChart3 className="size-4 text-primary" />
              Trend graph
            </div>
            <p className="mt-2 leading-6">
              Track how expected departure changes as the CSV rows accumulate.
            </p>
          </div>
          <div className="min-w-0 rounded-lg border border-border/80 bg-card/65 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-foreground">
              <CloudCog className="size-4 text-primary" />
              EC2-ready hook
            </div>
            <p className="mt-2 leading-6">
              The route now forwards CSV uploads to an EC2 realtime inference API.
            </p>
          </div>
        </div>
      </section>

      <section className="grid min-w-0 flex-1 gap-6 py-8 xl:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)]">
        <Card className="min-w-0 border-border/80 bg-card/78 shadow-sm">
          <CardHeader className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-xl">Feature CSV upload</CardTitle>
                <CardDescription>
                  Select a single feature CSV, then send it through the Vercel
                  relay route to the EC2 realtime-learning API.
                </CardDescription>
              </div>
              <Badge variant="outline" className="gap-1.5">
                <Upload className="size-3.5" />
                EC2 relay
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <label
              htmlFor="csv-upload"
              className="flex min-h-56 cursor-pointer flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-primary/35 bg-primary/6 px-6 py-8 text-center transition-colors hover:border-primary/55 hover:bg-primary/10"
            >
              <div className="rounded-full border border-primary/25 bg-background/70 p-3">
                <FileSpreadsheet className="size-6 text-primary" />
              </div>
              <div className="space-y-2">
                <p className="text-base font-medium text-foreground">
                  Drop the feature CSV here or click to browse
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  One file per request. The ideal input is a
                  `*_vehicle_counts.csv` generated by the AIP BUS YOLO pipeline.
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

            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                <div className="text-muted-foreground">Selected file</div>
                <div className="mt-2 truncate font-medium text-foreground">
                  {selectedFile ? selectedFile.name : "No file selected"}
                </div>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                <div className="text-muted-foreground">Size</div>
                <div className="mt-2 font-medium text-foreground">
                  {selectedFile ? formatFileSize(selectedFile.size) : "-"}
                </div>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                <div className="text-muted-foreground">MIME type</div>
                <div className="mt-2 truncate font-medium text-foreground">
                  {selectedFile ? selectedFile.type || "text/csv" : "-"}
                </div>
              </div>
            </div>

            {csvPreview?.headers.length ? (
              <div className="space-y-3 overflow-hidden rounded-lg border border-border/80 bg-background/85 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Table2 className="size-4 text-primary" />
                  CSV preview
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border/70 text-muted-foreground">
                        {csvPreview.headers.slice(0, 6).map((header) => (
                          <th key={header} className="px-3 py-2 font-medium">
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {csvPreview.rows.map((row, rowIndex) => (
                        <tr key={`${rowIndex}-${row[0] ?? "row"}`} className="border-b border-border/40">
                          {row.slice(0, 6).map((value, valueIndex) => (
                            <td
                              key={`${rowIndex}-${valueIndex}`}
                              className="max-w-44 truncate px-3 py-2 text-muted-foreground"
                            >
                              {value}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-xs text-muted-foreground">
                  Previewing the first few rows only.
                </div>
              </div>
            ) : (
              <div className="flex min-h-52 items-center justify-center rounded-lg border border-border/80 bg-background/65 text-sm text-muted-foreground">
                The selected CSV headers and sample rows appear here.
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleUpload} disabled={!selectedFile || isSubmitting}>
                {isSubmitting ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    Sending to EC2
                  </>
                ) : (
                  <>
                    <Upload />
                    Upload and infer
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={resetSelection}
                disabled={!selectedFile && !prediction && !error}
              >
                <Trash2 />
                Clear
              </Button>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/35 px-4 py-3 text-sm leading-6 text-muted-foreground">
              `POST /api/predictions` is the Vercel relay point. It accepts one
              feature CSV file, then forwards it to the EC2 realtime-learning
              API configured through environment variables.
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 border-border/80 bg-card/78 shadow-sm">
          <CardHeader className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-xl">Probability sector</CardTitle>
                <CardDescription>
                  Status, progressive trend graph, and bucket probabilities for
                  the latest inference run.
                </CardDescription>
              </div>
              <Badge variant={statusTone} className="gap-1.5">
                {prediction ? (
                  <CheckCircle2 className="size-3.5" />
                ) : isSubmitting ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : error ? (
                  <Activity className="size-3.5" />
                ) : (
                  <CircleDashed className="size-3.5" />
                )}
                {prediction
                  ? "Probability ready"
                  : isSubmitting
                    ? "Processing"
                    : error
                      ? "Needs retry"
                      : "Waiting"}
              </Badge>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>Inference progress</span>
                <span>{Math.round(progressValue)}%</span>
              </div>
              <Progress value={progressValue} className="h-2.5" />
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              {PIPELINE_STEPS.map((step, index) => {
                const isComplete = prediction ? true : index < activeStep;
                const isActive = !prediction && isSubmitting && index === activeStep;

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

            {prediction ? (
              <div className="space-y-6">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Clock3 className="size-4 text-primary" />
                      Expected departure
                    </div>
                    <div className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
                      {formatSeconds(prediction.summary.expectedDepartureInSec)}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      around {prediction.summary.predictedDepartureAt}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <BarChart3 className="size-4 text-primary" />
                      Most likely bucket
                    </div>
                    <div className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                      {prediction.summary.bestBucketLabel}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Source: {prediction.source}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Database className="size-4 text-primary" />
                      ROI out events
                    </div>
                    <div className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
                      {prediction.summary.gateOutEvents}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      blue markers on the trend graph
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <RefreshCw className="size-4 text-primary" />
                      Retrain count
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
                      Expected departure trend by elapsed time
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Hover a point to inspect departure timing
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="relative">
                      {hoveredPoint && tooltipPosition ? (
                        <div
                          className="pointer-events-none absolute z-10 w-52 -translate-x-1/2 -translate-y-[calc(100%+0.75rem)] rounded-lg border border-border/80 bg-popover/96 px-3 py-2 text-left shadow-lg backdrop-blur-sm"
                          style={tooltipPosition}
                        >
                          <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                            Expected departure
                          </div>
                          <div className="mt-1 text-sm font-semibold text-foreground">
                            {formatSeconds(hoveredPoint.expectedDepartureInSec)}
                          </div>
                          <div className="mt-2 text-xs leading-5 text-muted-foreground">
                            Current time {hoveredPoint.currentTimeLabel}
                          </div>
                          <div className="text-xs leading-5 text-muted-foreground">
                            Top bucket {hoveredPoint.topBucket} ({hoveredPoint.topBucketProbabilityPercent}%)
                          </div>
                          {hoveredPoint.currentGateOutEvent > 0 ? (
                            <div className="mt-2 inline-flex items-center gap-2 text-xs font-medium text-sky-600">
                              <span className="size-2 rounded-full bg-sky-500" />
                              ROI out detected
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      <svg
                        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                        className="h-64 w-full"
                        role="img"
                        aria-label="Expected departure trend chart"
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
                            aria-label={`${marker.point.currentTimeLabel}, expected departure ${formatSeconds(marker.point.expectedDepartureInSec)}`}
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
                            ROI out markers ({gateOutMarkerCount})
                          </span>
                          <span>
                            Range: {formatSeconds(lineChart.minValue)} - {formatSeconds(lineChart.maxValue)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-sm font-medium text-foreground">
                    Grouped bucket probability trends
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
                                  viewBox={`0 0 ${CHART_WIDTH} 220`}
                                  className="h-48 w-full"
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
                                    ROI out markers
                                  </span>
                                  <span>0% - 100% probability scale</span>
                                </div>
                              </div>
                            </>
                          ) : (
                            <div className="mt-4 rounded-lg border border-dashed border-border/70 bg-muted/25 px-4 py-5 text-sm leading-6 text-muted-foreground">
                              EC2 has not returned per-row bucket probabilities
                              for this grouped series yet.
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/70 bg-background/60 px-4 py-5 text-sm leading-6 text-muted-foreground">
                      Current EC2 JSON includes the final bucket snapshot, but it
                      does not yet expose per-row `prob_*` bucket probabilities.
                      Once the backend returns those progressive fields, the
                      grouped probability trends for `0-120`, `120-300`, and
                      `over 300 sec` will render here automatically.
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="text-sm font-medium text-foreground">
                    Final bucket snapshot
                  </div>
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
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="text-sm font-medium text-foreground">
                    Inference run details
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">Uploaded CSV</div>
                      <div className="mt-2 text-base font-semibold text-foreground">
                        {prediction.uploadedCsv.name}
                      </div>
                      <div className="mt-2 text-sm text-muted-foreground">
                        {prediction.uploadedCsv.rowCount} rows / {prediction.uploadedCsv.columnCount} columns
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">Columns detected</div>
                      <div className="mt-2 text-sm font-medium leading-6 text-foreground">
                        {prediction.uploadedCsv.columns.slice(0, 6).join(", ")}
                        {prediction.uploadedCsv.columns.length > 6 ? ", ..." : ""}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">Best bucket confidence</div>
                      <div className="mt-2 text-xl font-semibold text-foreground">
                        {prediction.summary.bestBucketProbabilityPercent}%
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">Generated at</div>
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
                    <div className="font-medium text-foreground">Integration notes</div>
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
                  Probability sector is waiting for a feature CSV
                </div>
                <p className="max-w-md text-sm leading-6 text-muted-foreground">
                  Upload one bus YOLO feature CSV from the left panel to see the
                  progressive departure trend, bucket probabilities, and
                  realtime-learning summary returned from EC2.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
