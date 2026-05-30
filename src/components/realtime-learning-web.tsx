"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  CheckCircle2,
  CircleDashed,
  CloudCog,
  Clock3,
  Film,
  LoaderCircle,
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
import type { PredictionResponse } from "@/lib/mock-prediction";

const PIPELINE_STEPS = [
  {
    label: "Video accepted",
    description: "The browser has staged the upload package.",
  },
  {
    label: "Upload received",
    description: "The Vercel route has the video payload and metadata.",
  },
  {
    label: "Tracking features",
    description: "Frame extraction and bus tracking placeholders are running.",
  },
  {
    label: "Probability model",
    description: "Departure buckets and ETA are being prepared.",
  },
  {
    label: "Sector ready",
    description: "The probability sector has finished rendering.",
  },
] as const;

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
  if (seconds < 60) {
    return `${seconds} sec`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes} min ${remainingSeconds} sec`;
}

export function RealtimeLearningWeb() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [prediction, setPrediction] = useState<PredictionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progressValue, setProgressValue] = useState(0);
  const [activeStep, setActiveStep] = useState(0);

  const previewUrl = useMemo(() => {
    if (!selectedFile) {
      return null;
    }

    return URL.createObjectURL(selectedFile);
  }, [selectedFile]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

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

  async function handleUpload() {
    if (!selectedFile) {
      return;
    }

    setError(null);
    setPrediction(null);
    setIsSubmitting(true);
    setProgressValue(8);
    setActiveStep(0);

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
      formData.append("video", selectedFile);

      const response = await fetch("/api/predictions", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as PredictionResponse | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "Failed to prepare a probability response.",
        );
      }

      if (!("prediction" in payload)) {
        throw new Error("The prediction response was missing its payload.");
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
    setPrediction(null);
    setError(null);
    setProgressValue(file ? 6 : 0);
    setActiveStep(0);
  }

  function resetSelection() {
    setSelectedFile(null);
    setPrediction(null);
    setError(null);
    setProgressValue(0);
    setActiveStep(0);
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
              Upload bus video and review departure probabilities on the web.
            </h1>
            <p className="max-w-3xl break-words text-sm leading-6 text-muted-foreground md:text-base">
              This Vercel web surface mirrors the AIP BUS realtime-learning flow:
              accept a video, stage tracking work, and render probability buckets
              that can later come from EC2.
            </p>
          </div>
        </div>

        <div className="grid min-w-0 gap-3 text-sm text-muted-foreground sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          <div className="min-w-0 rounded-lg border border-border/80 bg-card/65 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-foreground">
              <Film className="size-4 text-primary" />
              Upload input
            </div>
            <p className="mt-2 leading-6">
              MP4, MOV, AVI, MKV, and WebM files can be staged.
            </p>
          </div>
          <div className="min-w-0 rounded-lg border border-border/80 bg-card/65 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-foreground">
              <BarChart3 className="size-4 text-primary" />
              Probability sector
            </div>
            <p className="mt-2 leading-6">
              ETA and time-bucket probabilities update after each upload.
            </p>
          </div>
          <div className="min-w-0 rounded-lg border border-border/80 bg-card/65 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-foreground">
              <CloudCog className="size-4 text-primary" />
              EC2-ready hook
            </div>
            <p className="mt-2 leading-6">
              The current route is local mock data with the API seam ready.
            </p>
          </div>
        </div>
      </section>

      <section className="grid min-w-0 flex-1 gap-6 py-8 xl:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)]">
        <Card className="min-w-0 border-border/80 bg-card/78 shadow-sm">
          <CardHeader className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-xl">Video upload</CardTitle>
                <CardDescription>
                  Select one source video, then send it through the mock
                  inference route that can later forward to EC2.
                </CardDescription>
              </div>
              <Badge variant="outline" className="gap-1.5">
                <Upload className="size-3.5" />
                Web prototype
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <label
              htmlFor="video-upload"
              className="flex min-h-56 cursor-pointer flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-primary/35 bg-primary/6 px-6 py-8 text-center transition-colors hover:border-primary/55 hover:bg-primary/10"
            >
              <div className="rounded-full border border-primary/25 bg-background/70 p-3">
                <Upload className="size-6 text-primary" />
              </div>
              <div className="space-y-2">
                <p className="text-base font-medium text-foreground">
                  Drop the video here or click to browse
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  One file per request. The current web prototype keeps the
                  upload local and returns mock probabilities.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-full border border-border/80 px-2.5 py-1">
                  .mp4
                </span>
                <span className="rounded-full border border-border/80 px-2.5 py-1">
                  .mov
                </span>
                <span className="rounded-full border border-border/80 px-2.5 py-1">
                  .avi
                </span>
                <span className="rounded-full border border-border/80 px-2.5 py-1">
                  .mkv
                </span>
                <span className="rounded-full border border-border/80 px-2.5 py-1">
                  .webm
                </span>
              </div>
            </label>

            <input
              id="video-upload"
              type="file"
              accept="video/*,.mp4,.mov,.avi,.mkv,.webm"
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
                  {selectedFile ? selectedFile.type || "video/mp4" : "-"}
                </div>
              </div>
            </div>

            {previewUrl ? (
              <div className="overflow-hidden rounded-lg border border-border/80 bg-background/85">
                <video
                  key={previewUrl}
                  className="aspect-video w-full bg-black/55 object-contain"
                  controls
                  src={previewUrl}
                />
              </div>
            ) : (
              <div className="flex min-h-52 items-center justify-center rounded-lg border border-border/80 bg-background/65 text-sm text-muted-foreground">
                The selected video preview appears here.
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleUpload} disabled={!selectedFile || isSubmitting}>
                {isSubmitting ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    Preparing sector
                  </>
                ) : (
                  <>
                    <Upload />
                    Upload and predict
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
              The `POST /api/predictions` route is the handoff point for the EC2
              inference server. Right now it validates the video and returns a
              deterministic local probability response.
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 border-border/80 bg-card/78 shadow-sm">
          <CardHeader className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-xl">Probability sector</CardTitle>
                <CardDescription>
                  Status, ETA, and bucket probabilities for the latest upload.
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
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Clock3 className="size-4 text-primary" />
                      Expected departure
                    </div>
                    <div className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
                      {formatSeconds(prediction.prediction.expectedDepartureInSec)}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      around {prediction.prediction.predictedDepartureAt}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <BarChart3 className="size-4 text-primary" />
                      Most likely bucket
                    </div>
                    <div className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                      {prediction.prediction.bestBucketLabel}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Source: {prediction.source}
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-sm font-medium text-foreground">
                    Probability by time bucket
                  </div>
                  {prediction.prediction.buckets.map((bucket) => (
                    <div key={bucket.label} className="space-y-2">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <div>
                          <div className="font-medium text-foreground">
                            {bucket.label}
                          </div>
                          <div className="text-muted-foreground">
                            {bucket.etaStartLabel}
                            {bucket.etaEndLabel ? ` - ${bucket.etaEndLabel}` : "+"}
                          </div>
                        </div>
                        <div className="font-medium text-foreground">
                          {bucket.probabilityPercent}%
                        </div>
                      </div>
                      <Progress value={bucket.probabilityPercent} className="h-2" />
                    </div>
                  ))}
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="text-sm font-medium text-foreground">
                    Tracking telemetry placeholder
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">Tracked buses inside</div>
                      <div className="mt-2 text-xl font-semibold text-foreground">
                        {prediction.prediction.telemetry.busCountInside}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">Total waiting time</div>
                      <div className="mt-2 text-xl font-semibold text-foreground">
                        {formatSeconds(
                          prediction.prediction.telemetry.totalWaitingTimeSec,
                        )}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">Seconds since last in</div>
                      <div className="mt-2 text-xl font-semibold text-foreground">
                        {formatSeconds(
                          prediction.prediction.telemetry.secondsSinceLastNewBus,
                        )}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 p-4">
                      <div className="text-sm text-muted-foreground">Seconds since last out</div>
                      <div className="mt-2 text-xl font-semibold text-foreground">
                        {formatSeconds(
                          prediction.prediction.telemetry.secondsSinceLastOutBus,
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-primary/20 bg-primary/8 px-4 py-3 text-sm leading-6 text-muted-foreground">
                  {prediction.integrationNote}
                </div>
              </div>
            ) : (
              <div className="flex min-h-72 flex-col justify-center gap-3 rounded-lg border border-dashed border-border/75 bg-background/60 px-5 py-6">
                <div className="flex items-center gap-2 text-foreground">
                  <BarChart3 className="size-5 text-primary" />
                  Probability sector is waiting for a video upload
                </div>
                <p className="max-w-md text-sm leading-6 text-muted-foreground">
                  Upload one video from the left panel to see ETA, probability
                  buckets, and placeholder telemetry based on the AIP BUS
                  realtime-learning workflow.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
