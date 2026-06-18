# Session Analytics vs. the native Hermes dashboard

This document explains how the **Session Analytics** plugin improves on the
analytics that ship with Hermes Agent out of the box. The goal is for the plugin
to match and surpass the native dashboard's session insights.

## Scope

This compares the plugin against the **built-in Hermes web dashboard** — its
**Sessions** page and its **Analytics** page (the ones served by `hermes
dashboard`).

It is *not* the same thing as the Loki-backed `dashboards/session-analytics/`
single-page app (a static SPA + `dashboard_server.py` sidecar that reads from
Grafana Loki). That lives in the deployment repo and is a separate system. This
plugin reads directly from the local Hermes state store (`state.db`) and the
session routing index (`sessions/sessions.json`).

## At a glance

| Dimension | Native Hermes dashboard | This plugin |
|---|---|---|
| Time ranges | Fixed presets: 7 / 30 / 90 days | Presets **plus** custom `since`/`until`, `seconds`, and `days` up to 365 |
| Cost / token analytics | On the **Analytics** page, hidden by default behind `dashboard.show_token_analytics` (the local estimate is known to undercount, so it's gated to avoid being mistaken for billing) | Surfaced as the primary view — overview totals, daily series, and cost breakdowns |
| User attribution | Raw `user_id` + a per-source breakdown | Resolves Slack **display names**, classifies each initiator as **human / automation / cron / system**, and breaks cost down **per user** and **per platform** (webhooks + crons) |
| Top spenders | Not available | **Top-N most expensive sessions**, filterable by source |
| Tool analytics | `tool_call_count` per session only | **Global** tool usage and **per-session** tool breakdown, each with **average latency** (computed from request→result timestamps) |
| Conversation view | Renders the raw stored message — including the `[Thread context …]`, `[Replying to: …]`, and `[sender]` prefixes the gateway injects | Parses those prefixes into a clean message + **author** + a collapsible **context** block, adds an **"Open in Slack"** deep link, and lists **skill triggers** |
| Per-model view | Per-model token + cost table | Per-model **and** `billing_provider` rollups (sessions, cost, input/output/cache/reasoning tokens, messages, tool/api calls) |
| Full-text search | FTS5 search across all message content | Not yet — a gap to close |
| Session resume / title edit | Yes (native session management) | Read-only analytics |

## Assumptions — what's tuned for a Slack-fronted Hermes

The cost/token/tool aggregation works on any Hermes deployment. The
**attribution and conversation-cleanup logic**, however, encodes conventions
from a Slack-fronted Hermes gateway (such as the Hermes-Kite bot). None of these
hold any hardcoded IDs or secrets, and all of them **fail soft** — on a standard
or non-Slack deployment they simply return nothing rather than erroring.

All references below are to [`dashboard/plugin_api.py`](dashboard/plugin_api.py).

- **Slack ID = "human"** (`_SLACK_USER_RE`, line 112). A `user_id` matching the
  Slack format (`^U[A-Z0-9]{5,}$`) is classified as a human. On
  Telegram/Discord/CLI deployments nobody matches, so real users fall into
  "system".
- **`cron:` / `webhook:` prefixes** (`classify_user`, lines 180-188). Initiators
  tagged `cron:<name>` or `webhook:<name>` drive the "Cron Jobs" and
  "Automations (Webhooks)" groupings; the prefix is stripped for display.
- **Message-prefix parsing** (`_parse_user_message`, lines 115-177). Strips the
  `[Thread context — …]`, `[Replying to: "…"]`, and `[sender]` markers the
  gateway prepends to user messages, returning a clean message, an `author`, and
  a collapsible `context`. If those markers are absent, the raw text is shown
  as-is.
- **Slack deep links** (`_build_slack_link`, lines 213-224). Builds
  `https://app.slack.com/archives/…` links from `origin.chat_id` /
  `origin.thread_id`. Returns nothing when `origin.platform != "slack"`.
- **`sessions.json` `origin` shape** (`_resolve_user_names` /
  `_find_session_origin`, lines 191-250). Expects each routing entry to carry a
  nested `origin` with `user_id`, `user_name`, `platform`, `chat_id`,
  `thread_id`. Without it you lose friendly names and Slack links.
- **Skill-trigger scraping** (lines 605-609). Collects assistant lines
  containing both `"Skill "` and `"triggered"` into a skills list. Depends on the
  setup emitting that phrasing into message content.

## Data sources

- `state.db` — opened **read-only** (`file:…?mode=ro`) to avoid write-lock
  contention with the running gateway. Reads the `sessions` and `messages`
  tables.
- `sessions/sessions.json` — the routing index, used for display-name resolution
  and Slack link construction.

Both are resolved relative to `HERMES_HOME` (falling back to `~/.hermes`).
