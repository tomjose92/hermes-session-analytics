# Session Analytics — Hermes dashboard plugin

A Hermes Agent **dashboard plugin** that adds a Session Analytics tab to the web
dashboard: cost analytics, tool-usage breakdown, token metrics, and Slack user
attribution for Hermes sessions (read from `state.db`).

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
