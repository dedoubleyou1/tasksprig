# TaskSprig

A local desktop task companion that turns plain-language requests into useful
lists, recurring routines, and reminders. Built with Electron, React, and
TypeScript as an MIT-licensed hackathon prototype.

Tell the agent what matters in plain language. It infers timing, effort, and
useful next steps, writes small JavaScript behaviors, and creates custom lists
and recurring routines to fulfill your requests.

## What it does

- Creates custom task lists from requests such as “What can I do in 20 minutes?”
- Tracks recurring tasks and runs routines while the app is open.
- Supports Anthropic, OpenAI, and Google providers through the Pi agent runtime.
- Accepts spoken requests using OpenAI transcription.
- Stores tasks and conversations locally in SQLite.
- Includes a no-key demo mode with sample tasks and a controllable clock.

Local storage does not mean local model inference: live chat sends relevant
context to your chosen provider, and voice input sends audio to OpenAI.

## Run on macOS

Requires Node.js 22.19+ and npm.

```sh
git clone https://github.com/dedoubleyou1/tasksprig.git
cd tasksprig
npm ci
npm run build
npm start
```

For UI development with hot reload:

```sh
npm run dev
```

To create a standalone local macOS app:

```sh
npm run package:mac
```

The app is written to `artifacts/TaskSprig-darwin-arm64/TaskSprig.app` on Apple Silicon.
See [packaging notes](docs/PACKAGING.md) for Intel Macs and isolated demo data.

The app initially opens with a resettable sample workspace in **Demo** mode.
Demo mode uses a limited, deterministic interpreter for example requests; it
does not call a model and is clearly labeled. Select a real provider in Menu → Settings
to use the open-source Pi agent runtime for unrestricted natural-language input.

## Connect a model

Open Menu → Settings, choose a provider, enter a model ID and API key, and save.
Keys are encrypted using Electron's macOS credential storage facilities and
never sent to the renderer after saving. You can instead launch the app with
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` in its environment.
Do not commit credentials.

Each provider keeps its own saved key. Adding a Google key does not replace your
OpenAI key; leave the key field blank to keep the selected provider's saved key.

Google's Gemini API hosts `gemma-4-26b-a4b-it` and `gemma-4-31b-it`, including
function calling. Choose **Google / Gemma** to use one of those models. See
[Google's Gemma API guide](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api).
Anthropic and OpenAI are available as interchangeable alternatives. Model access
depends on your provider account; the model ID is editable.

Task records and conversations are stored locally. Live mode sends relevant
task context and conversation text to the selected model provider.

## Demo flow

1. Reset the sample workspace using Menu → Demo controls. It includes daily medicine,
   a weekly shot reminder, monthly dog medicine, fortnightly plants, and a proposal.
2. Ask: “What can I do in 20 minutes?” A custom list appears.
3. Ask: “Pick three priorities for me every morning.”
4. Advance to the next morning to execute the routine and see the selection change.
5. Complete watering and advance two weeks to see it become relevant again.
6. Inspect the proposal under All items to see its actionable subtasks.
7. Restart the app: tasks, generated behavior, routines, and lists persist.

The main screen shows one list and a place to make requests. Newly created or
updated lists open automatically. Choose another list from the header; expand a
task for its details. Calendar, routines, conversation history, settings, and demo
controls are available from Menu.

Checking an item fades it and moves it below the active items. Uncheck it to
undo the completion, including the most recent occurrence of a recurring task.
Expanded items show plain information. Each list highlights one or two fields
chosen by the agent, such as a due date, effort estimate, tags, or selection
reason.

Tasks can have multiple flexible tags. The agent creates or reuses tags when
helpful for grouping and selection; existing categories migrate into tags.

The agent can also choose when a list hides completed items. An enforced
30-second grace period in real time leaves room to undo mistakes, including when
the demo clock changes. Hiding an item preserves
its details and completion history; ask “show what I finished this morning” to
bring completed work back into view.

The agent chooses whether a list has lasting value. Ad hoc selections normally
last until you switch lists or send another request; recurring or ongoing lists
stay saved. Say “keep this list” or “make this temporary” to change that choice.
Temporary lists stay in memory only. Dismissing a list never removes its tasks.

Click the microphone to speak a request. Words appear in the input as you speak.
After you start speaking, a two-second pause finishes the transcript and sends
the request; clicking Stop sends it sooner. Press Escape to cancel and restore
your original draft. Voice uses your saved OpenAI key independently of the chat
provider. Audio streams to OpenAI for transcription and is not saved locally.
Sessions are limited to one minute, and initial silence does not send a request.
macOS asks for microphone permission the first time.

Lists can be live selections or stable snapshots. They reference the same
underlying tasks, so completion is shared across lists. The built-in calendar
shows due dates and routine times; it is not an external calendar integration.

Daily routines run while the app is open. On reopening, missed daily executions
are coalesced into one current run. There is no daemon or system notification
delivery while the app is fully quit.

Time travel changes the current workspace; returning to real time is not undo.
Use sample data for the clock demo.

## Architecture

- **Electron + React:** a local window with a narrow preload API.
- **SQLite via sql.js:** persistent local state with atomic database exports.
- **Pi agent core:** provider-neutral agent loop and scoped application tools.
- **QuickJS WebAssembly:** generated timing, selection, and trigger functions,
  with memory/execution limits and JSON-only input/output.
- **Durable scheduler:** persisted callback execution records and a shared
  injectable clock for real execution and time-travel demos.

The model defines behavior; the app owns persistence, validation, execution,
and applying mutations. Generated code has no filesystem, network, process,
or credential APIs. Ordinary users interact with explanations and corrections,
not code. Failed behavior updates retain the previous working version.

Source ownership is divided into `src/main/engine`, `src/main/agent`, and
`src/renderer`; their shared interface is `src/shared/types.ts`.

The default data directory is Electron's user-data directory for TaskSprig
(normally `~/Library/Application Support/TaskSprig`). Set `TASKSPRIG_DATA_DIR` to use a
separate workspace, including during tests. Demo reset replaces that workspace's
task data; it does not change your model credentials.

If you used the earlier Tend prototype, TaskSprig reuses its existing data
directory when no TaskSprig directory exists. `TEND_DATA_DIR` remains supported
as a fallback for `TASKSPRIG_DATA_DIR`; the database filename remains
`tend.sqlite` so existing workspaces continue to open.

## Verify

```sh
npm test
npm run build
npm run smoke
```

The desktop smoke test opens a temporary workspace, exercises actual controls,
checks encrypted credential persistence using a fake test key, and restarts.
It makes no model calls. Screenshots are written to the ignored `artifacts/` folder.

The optional `npm run check:live` integration check uses the provider configured
in the app. It sends only invented sample tasks from an empty temporary database
and never reads the real task database. It runs two agent requests to verify
generated list selection and timing behavior; each may make several billable
model calls. Set `TASKSPRIG_CHECK_PROVIDER=openai`, `anthropic`, or `google` to use a
specific saved provider key without changing the app's selected provider.

`npm run check:voice` checks the live transcription connection using an invented
reminder spoken by macOS speech synthesis. It never records the microphone or
reads task data, and makes one billable OpenAI transcription request.

## Contributing

Issues and pull requests are welcome. Include steps to reproduce bugs and run
`npm test` and `npm run build` before submitting changes. For desktop UI changes,
also run `npm run smoke` on macOS. Keep credentials, local databases, and generated
artifacts out of commits.

## License

Licensed under the [MIT License](LICENSE).

This is a hackathon prototype, with explicit app-open scheduling
and a deliberately small UI. Medication examples record user-specified reminder
cadences; they do not determine dosage or missed-dose instructions.
