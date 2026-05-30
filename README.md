# AIP BUS Realtime Learning Web

Vercel/Next.js based web frontend for the AIP BUS realtime-learning workflow.

This repository was created as a separate web project while using the
`realtime-learning` branch in the `AIP BUS` repository as the reference for the
prediction shape and UI direction.

The current goal of this repo is:

- let a user upload a bus video in the browser
- show a probability sector for the next departure window
- keep the web layer ready for later EC2 inference integration

## Current Status

As of May 30, 2026, the web prototype includes:

- video upload UI
- local video preview
- progress/status pipeline UI
- probability bucket sector UI
- mock prediction API route at `POST /api/predictions`
- deterministic local mock response shaped for later EC2 replacement

What is not done yet:

- no real EC2 upload
- no polling/webhook flow for long-running inference
- no persistent job history or saved results
- no authentication

## Reference From AIP BUS

This web project was designed around the output style used in the `AIP BUS`
`realtime-learning` work:

- time-bucket probabilities such as `0-30 sec`, `30-60 sec`, `60-120 sec`
- expected departure ETA
- telemetry-style fields such as:
  - `busCountInside`
  - `totalWaitingTimeSec`
  - `secondsSinceLastNewBus`
  - `secondsSinceLastOutBus`

The current mock implementation lives in
[`src/lib/mock-prediction.ts`](./src/lib/mock-prediction.ts).

## Run Locally

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Useful checks:

```bash
npm run lint
npm run build
```

## Main Files

- [`src/app/page.tsx`](./src/app/page.tsx)
  - app entry page
- [`src/components/realtime-learning-web.tsx`](./src/components/realtime-learning-web.tsx)
  - main upload screen and probability sector UI
- [`src/app/api/predictions/route.ts`](./src/app/api/predictions/route.ts)
  - temporary backend route for upload validation and mock inference response
- [`src/lib/mock-prediction.ts`](./src/lib/mock-prediction.ts)
  - mock probability generator and response types

## Current API Behavior

`POST /api/predictions`

Request:

- `multipart/form-data`
- file field name: `video`

Validation:

- accepts common video types such as `mp4`, `mov`, `avi`, `mkv`, `webm`
- rejects empty files
- rejects files larger than 1 GB

Current response behavior:

- waits briefly to simulate processing
- returns a deterministic mock prediction payload based on file metadata
- includes:
  - request id
  - uploaded file metadata
  - expected departure seconds
  - probability buckets
  - telemetry placeholders

## Next Recommended Work

Recommended next steps for continuing this project on another PC:

1. Deploy this repository to Vercel and confirm the production URL.
2. Replace the mock implementation in
   [`src/app/api/predictions/route.ts`](./src/app/api/predictions/route.ts)
   with a real EC2 request.
3. Decide on the EC2 interaction model:
   - synchronous request/response
   - upload + job id + polling
   - upload + callback/webhook
4. Keep the response contract compatible with the existing UI so the frontend
   does not need a large rewrite.
5. Add loading/error states for real network latency and failed inference jobs.

## Notes For Handoff

If you continue this from another machine such as a PC bang:

1. clone the repo
2. run `npm install`
3. run `npm run dev`
4. continue from the EC2 integration point above

The repository is already in a workable state for frontend continuation. The
main missing context used to be the project intent, so this README is meant to
be the handoff summary for the next session.
