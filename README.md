# AIP BUS Realtime Learning Web

Vercel/Next.js web frontend for the AIP BUS realtime-learning workflow.

This repository is the web layer. It accepts a bus YOLO feature CSV upload,
relays that CSV to an EC2 inference API, and visualizes the returned realtime
learning result with charts and bucket probabilities.

## Current Architecture

Current request flow:

1. user uploads a `*_vehicle_counts.csv` file in the browser
2. Next.js route `POST /api/predictions` validates the file
3. the route forwards the CSV to the EC2 inference endpoint
4. EC2 runs `realtime_departure_learning.py`
5. EC2 returns a JSON payload
6. the web app renders:
   - summary cards
   - expected departure trend graph
   - bucket probability chart
   - inference details

## Input File

Expected upload input:

- bus YOLO feature CSV
- typical file name: `*_vehicle_counts.csv`
- expected source: AIP BUS outputs

The CSV should come from the AIP BUS pipeline, not from manual spreadsheet
editing.

## Environment Variables

Create `.env.local` only for local development.

Example values are in [`.env.example`](./.env.example).

For Vercel Preview and Production deployments, set the same variables in the
Vercel Dashboard under Project Settings -> Environment Variables. Do not rely
on `.env.local` in production.

Server-side variables:

- `EC2_REALTIME_LEARNING_URL`
  - full EC2 API URL
  - example: `https://your-ec2-api.example.com/inference/realtime-learning`
- `EC2_INFERENCE_API_KEY`
  - shared secret sent as `x-api-key`
  - server-only variable; do not expose it in client components
- `EC2_REQUEST_TIMEOUT_MS`
  - optional relay timeout in milliseconds
  - defaults to `180000`

If either `EC2_REALTIME_LEARNING_URL` or `EC2_INFERENCE_API_KEY` is missing,
`POST /api/predictions` returns a clear server configuration error. The app
does not fall back to localhost, mock inference, or any local machine URL.

## Run Locally

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Open the local URL printed by `npm run dev`.

Checks:

```bash
npm run lint
npm run build
```

## Main Files

- [`src/components/realtime-learning-web.tsx`](./src/components/realtime-learning-web.tsx)
  - main CSV upload screen and chart dashboard
- [`src/app/api/predictions/route.ts`](./src/app/api/predictions/route.ts)
  - Vercel relay route for forwarding CSV uploads to EC2
- [`src/lib/inference-contract.ts`](./src/lib/inference-contract.ts)
  - shared JSON contract expected from EC2
- [`src/lib/csv-utils.ts`](./src/lib/csv-utils.ts)
  - CSV parsing helpers used by upload preview logic

## EC2 JSON Contract

The web expects EC2 to return a JSON payload shaped like this:

```ts
type RealtimeInferenceResponse = {
  requestId: string;
  status: "completed";
  source: string;
  uploadedCsv: {
    name: string;
    sizeBytes: number;
    mimeType: string;
    rowCount: number;
    columnCount: number;
    columns: string[];
  };
  summary: {
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
  finalBuckets: Array<{
    label: string;
    startSec: number;
    endSec: number | null;
    probability: number;
    probabilityPercent: number;
    etaStartLabel: string;
    etaEndLabel: string | null;
  }>;
  progressivePoints: Array<{
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
  }>;
  notes: string[];
};
```

The easiest EC2 implementation is:

1. receive uploaded CSV
2. save it to a temp path
3. run `realtime_departure_learning.py --csv <temp file>`
4. read:
   - `*_realtime_probability.csv`
   - `*_realtime_progressive.csv`
5. convert both outputs into the JSON contract above
6. return JSON to the Vercel app

## Important Limit

When deployed on Vercel, the relay route is still subject to Vercel Function
request size limits.

That means:

- small and medium feature CSV files are fine
- very large CSV files should eventually use direct browser-to-EC2 upload or an
  object-storage upload flow

Right now the app keeps the relay route because it matches the current prototype
goal and keeps the frontend architecture simple.

## Deployment Flow

In Vercel production, the intended request path is:

1. user uploads a feature CSV on the deployed Vercel URL
2. browser sends the file to `POST /api/predictions`
3. the Next.js server route reads `EC2_REALTIME_LEARNING_URL`,
   `EC2_INFERENCE_API_KEY`, and `EC2_REQUEST_TIMEOUT_MS`
4. the server route forwards the CSV to the EC2 FastAPI endpoint
5. EC2 returns JSON
6. the Vercel app renders charts and bucket probabilities from that response
