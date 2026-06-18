# Session Analytics — Hermes dashboard plugin

A Hermes Agent **dashboard plugin** that adds an attribution-aware Session
Analytics tab to the web dashboard: cost, token, and tool analytics broken down
by user, platform, and model — plus a cleaned-up conversation view with Slack
links. It reads directly from the local Hermes state store (`state.db`) and the
session routing index (`sessions/sessions.json`); it never calls an LLM and
opens the database read-only.

It installs as a tab in the web dashboard and aims to be a richer, more capable
take on session insights than what ships with Hermes out of the box.

## What it does

Each capability is backed by a route under
`/api/plugins/session-analytics/` ([`dashboard/plugin_api.py`](dashboard/plugin_api.py)):

- **Overview** (`/overview`) — total sessions, messages, tool/api calls, tokens
  (input/output/cache/reasoning), and estimated cost; broken down by source and
  model, with a daily time-series.
- **Cost analytics** (`/costs`) — cost by model, source, user, and platform
  (webhooks + crons), a daily cost series, and the **top-N most expensive
  sessions** (filterable by source).
- **Sessions list** (`/sessions`) — filter by source / model / user / minimum
  cost / active; sort by recency, cost, tokens, messages, or duration; with
  computed fields like tokens-per-message, live-session detection, and resolved
  display names.
- **Session detail** (`/sessions/{id}/detail`, `/tools`, `/timeline`) — a cleaned
  conversation (gateway prefixes parsed out into author + context), per-session
  tool breakdown with **average latency**, a message timeline with inter-message
  latency, the list of **skills triggered**, and an **"Open in Slack"** deep
  link.
- **Users** (`/users`) — per-user session count, cost, tokens, messages, and tool
  calls, with Slack display names and a **human / automation / cron / system**
  classification.
- **Models** (`/models`) — per-model and per-`billing_provider` rollups of
  sessions, cost, tokens, and call counts.
- **Flexible time ranges** — presets, `days` (up to 365), `seconds`, or a custom
  `since`/`until` window on every analytics endpoint.

## How it differs from the native Hermes dashboard

The native dashboard's **Analytics** page offers fixed 7/30/90-day token and cost
estimates (now hidden by default). This plugin goes further — adding cost
attribution per user / platform / model, the priciest sessions, tool usage and
latency, flexible time ranges, and a cleaned-up conversation view with Slack
links.

See [COMPARISON.md](./COMPARISON.md) for a full feature-by-feature breakdown and
the Slack/Hermes-specific assumptions.

## Layout

```
dashboard/
  manifest.json      # tab config, icon, entry point, API
  dist/
    index.js         # pre-built JS bundle (IIFE, uses window.__HERMES_PLUGIN_SDK__)
    style.css        # plugin styles
  plugin_api.py      # FastAPI router → /api/plugins/session-analytics/*
```

This is discovered by directory layout — it is a dashboard plugin and does **not**
need to be listed in `config.yaml` `plugins.enabled` (that list is only for
CLI/gateway plugins with `plugin.yaml`/`__init__.py`).

## Install (Hermes-native distribution)

Clone this repo into the Hermes plugins directory so the dashboard discovers it at
`<HERMES_HOME>/plugins/session-analytics/dashboard/`:

```bash
git clone https://github.com/tomjose92/hermes-session-analytics.git \
  "$HERMES_HOME/plugins/session-analytics"
```

Then restart `hermes dashboard` (plugin API routes mount once at startup), or for
UI-only changes force a rescan:

```bash
curl http://127.0.0.1:9119/api/dashboard/plugins/rescan
```

## Deployment

The Hermes Kite container clones/pulls this repo into
`/opt/data/plugins/session-analytics` on every boot, so each deploy/restart picks
up the latest `main`. Pin a specific ref with the `SESSION_ANALYTICS_PLUGIN_REF`
env var.

## Data sources & assumptions

Reads `state.db` (read-only) and `sessions/sessions.json`, both relative to
`HERMES_HOME` (falling back to `~/.hermes`). The aggregation is generic to any
Hermes deployment; the attribution and conversation-cleanup logic is tuned for a
Slack-fronted Hermes and degrades gracefully elsewhere — see the assumptions
section in [COMPARISON.md](./COMPARISON.md).
