# Assessments

An assessment is a site visit where the work gets looked at before it's priced. This wave gives
a visit one working surface — in the field and in the office — that carries what Lead Control's
site-visit view carried: the camera and its photos, the checklists, the measurements, and a
spoken walkthrough that can turn into a proposal. Nothing here is a separate app or a separate
record: it's all on the visit, and the visit is what the schedule, the job and the client
already point at.

## The visit, in the field

The field visit page (`/field/visits/:id`) is where an assessment happens:

- **The camera** (`VisitCamera.tsx`): opens the phone's back camera in the page, takes as many
  shots as needed in one go, shows them in a strip to drop the bad ones, then adds them all to
  the visit's photos at once. They go through the same queue as picked photos, so they upload
  when there's signal. When the camera can't open — no permission, a browser that can't reach
  one — it says so in plain words and points at **Add photos**, which still works.
- **Checklists**: the visit's checklists, filled in on the visit as before
  (`checklist_responses` against `checklist_templates`).
- **Measurements** (`VisitMeasurements.tsx`): each room or area as a label with its length,
  width and — when it was taken — ceiling height, in feet. The areas are worked out from the
  dimensions (`roomAreas` in `@crewtavo/core/roomMeasurements`): walls are the perimeter times
  the height, the ceiling is length times width. A measurement can carry a note and point at
  one of the visit's photos. The section shows the visit's totals at the bottom, for the
  office to price from. Subs never see this section.
- **The voice walkthrough** (`VoiceWalkthrough.tsx`): tap Record, talk through the property,
  stop. The recording uploads right away (`POST /visits/:id/voice-reports`) and comes back as a
  report: where it stands in plain words, then its transcript and the work items structured
  out of it. A ready report becomes a draft proposal in one tap (below).

## The visit, in the office

Tapping a visit on the calendar opens its details (`VisitDetails.tsx`) — the same facts as
before (when, where, who, crew, codes, notes), and below them, in the same quiet style, what
the visit produced, each piece only when there is some:

- a strip of the visit's photos (up to eight thumbnails, "+N more" past that, and the count;
  tapping one opens it full size),
- a line per checklist: its name and **Done** or **In progress**,
- one measurements line: how many rooms, and the total wall area where heights were taken
  (ceilings alone are counted as surfaces),
- the latest voice walkthrough: **Voice walkthrough — N items** when it's ready, or the plain
  status when it isn't — including "needs the OpenAI key (Apps → ChatGPT)" when that's what's
  missing.

**Open visit** in the actions takes office staff to the full working visit — camera,
checklists, measurements, voice — the same page the field uses. It used to be field-only.

## Voice walkthrough → proposal

The pipeline (`apps/api/src/services/voiceReports.ts`) is three steps, and the report's
`status` says which one it's on:

1. **Recorded** — the recording is saved on the visit (an `attachments` row; the report row
   holds its path in the files bucket).
2. **Transcribed** — OpenAI's transcription (Whisper, `integrations/transcribe.ts`) turns the
   recording into words, using the company's own OpenAI key from **Apps → ChatGPT**. With no
   key the report stops at `needs_key` and says so; the recording is kept either way.
3. **Ready** — the transcript is structured into work items (`{title, detail, quantity,
   unit}`) by whichever AI the company already has (`services/ai`), capped at 50 items. If
   structuring fails, the report stays `transcribed` — the transcript is the value, and a
   person can read the items out of it.

**Convert to proposal** makes a **draft** quote for the visit's client with the report's items
as lines, priced at **$0** — a human prices it. Nothing is sent to the client. A report already
converted points at the draft it made (`quote_id`).

## Where the data lives

- `visit_measurements` — one row per measured room/area: `visit_id`, `label`, `length_ft`,
  `width_ft`, `height_ft` (nullable), `notes`, `photo_id` (an `attachments.id`, loosely — no
  foreign key). Areas are never stored; they're computed from the dimensions.
- `visit_voice_reports` — one row per recording: `visit_id`, `audio_path`, `transcript`,
  `items` (jsonb array), `status` (`recorded` / `needs_key` / `transcribed` / `ready` /
  `failed`), `problem` (the failure in plain words), `quote_id` once converted.
- `attachments` — the visit's photos (`owner_type = 'visit'`, `owner_id = the visit`), and the
  voice recordings as rows of their own. The office dialog reads the photos through
  `photoLinks` (`lib/photoMarkup.ts`), the same signed links the field page shows.
- `checklist_responses` / `checklist_templates` — the checklists, as before.

Migration: `supabase/migrations/20261124000600_assessment_wave.sql`. All of it is read and
written under the usual row-level security, as the signed-in person.

## Limits

Bluntly, because these are the ones that bite:

- **The camera is the browser's camera** (`getUserMedia`): it needs HTTPS and the person's
  permission. On iPhone it works in Safari and in the installed app — but a web page **cannot**
  use the LiDAR scanner or ARKit measuring; Apple doesn't expose them to websites. So there is
  no scan-the-room measuring and nothing here pretends there is: measuring is tape-measure
  dimensions typed in, with the areas worked out for you. If automatic measuring ever arrives,
  it will come from a native app handing dimensions in, and they will land in the same
  `visit_measurements` table.
- **Voice recording uses `MediaRecorder` in the open page**: it uploads right away, so it
  needs signal — recordings are **not** queued on the phone (with no signal, the section says
  so and recording is off). Mobile browsers can also stop a recording if the app is closed or
  the phone locks for long: keep the app open while talking.
- **Transcription is OpenAI's, with the company's own key** (Apps → ChatGPT). Claude can't
  transcribe audio — there is no Claude audio endpoint — so without that key there is no
  transcript. The recording is still saved on the visit, and the screen says what's missing
  instead of failing quietly. Turning the transcript into items uses whichever AI the company
  already has (`services/ai`).
- **Convert-to-proposal makes a DRAFT with $0 prices** for a human to price. Nothing is sent
  to the client, and the items are only what the estimator said out loud — a walkthrough that
  skipped a room made a proposal that skips it too.
