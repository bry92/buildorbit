# buildorbit CLI

Stream your 6-phase builds from the terminal.

```
buildorbit run "Build a SaaS waitlist page with email capture"
```

```
BuildOrbit — deterministic 6-phase builder
  buildorbit.polsia.app

🔍 [1/6] INTENT_GATE ━━━━━━━━━━────────────── generating...
🔍 [1/6] INTENT_GATE ━━━━━━━━━━────────────── done
   intent: INTERACTIVE_LIGHT_APP
   no_auth: true
   max_files: 8

📋 [2/6] PLAN ━━━━━━━━━━━━━━━━━━────────────── done
   ## Plan
   1. Create HTML landing page with email form
   ...

🏗️  [3/6] SCAFFOLD ━━━━━━━━━━━━━━━━━━━━━━──── done
   index.html
   styles.css
   app.js

💻 [4/6] CODE ━━━━━━━━━━━━━━━━━━━━━━━━━━━───── done
   3 files, ~240 lines

💾 [5/6] SAVE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━─── done
✅ [6/6] VERIFY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ done
   ✓ contract_conformance
   ✓ completeness
   ✓ constraint_violations

────────────────────────────────────────────────────────────
✅  Build complete
    Time: 34.2s
    Verify: 3/3 checks passed

    Live:      https://...
    Artifacts: https://buildorbit.polsia.app/a2a/artifacts/...
    Run ID:    abc12345-...
────────────────────────────────────────────────────────────

📁 Artifacts written to ./output/abc12345 (3 files)
```

## Install

```bash
npm install -g buildorbit
```

## Authentication

Get your API key at **https://buildorbit.polsia.app/settings/api-keys**, then:

```bash
buildorbit login
# paste your bk_... key when prompted
```

Or:

```bash
buildorbit login --token bk_your_key_here
```

## Commands

### `buildorbit run <task>`

Execute a build and stream the 6 phases live.

```bash
# Basic usage
buildorbit run "Build a SaaS landing page for an AI productivity tool"

# Override intent class
buildorbit run "Build a mortgage calculator" --intent-class INTERACTIVE_LIGHT_APP

# With product context
buildorbit run "Build a waitlist page" \
  --name "LaunchWave" \
  --tagline "Ship faster" \
  --color "#6366f1" \
  --domain "launchwave.com"

# Custom output directory
buildorbit run "Build a dashboard" --output ./builds
```

**Intent classes:**
| Class | Use when |
|-------|----------|
| `STATIC_SURFACE` | Landing pages, marketing sites (no backend) |
| `INTERACTIVE_LIGHT_APP` | Forms, calculators, waitlists |
| `PRODUCT_SYSTEM` | SaaS, dashboards, full-stack + auth |

Artifacts are written to `./output/<run-id>/`.

### `buildorbit status [runId]`

Check run status. Omit `runId` to use the last run.

```bash
buildorbit status
buildorbit status abc12345-def6-7890-abcd-ef1234567890
```

### `buildorbit history`

List recent local run history.

```bash
buildorbit history
buildorbit history --limit 25
buildorbit history --verbose  # shows live URLs
```

### `buildorbit login`

Store your API key.

```bash
buildorbit login
buildorbit login --token bk_your_key_here
```

### `buildorbit logout`

Remove stored key.

### `buildorbit whoami`

Show masked token info.

## Config

Stored in `~/.buildorbit/config.json`:
```json
{
  "token": "bk_..."
}
```

Run history in `~/.buildorbit/history.json` (last 50 runs, local only).

## The 6 Phases

| # | Phase | What happens |
|---|-------|-------------|
| 1 | `INTENT_GATE` | Classifies intent, compiles immutable constraint contract |
| 2 | `PLAN` | Generates structured technical plan within constraints |
| 3 | `SCAFFOLD` | Creates binding file/project manifest (CODE cannot deviate) |
| 4 | `CODE` | Implements every file in the manifest |
| 5 | `SAVE` | Persists artifacts with versioning |
| 6 | `VERIFY` | Validates against plan + constraints, typed pass/fail checks |

## Publishing

```bash
cd cli
npm publish
```

Requires npm login with publish rights to the `buildorbit` package name.
