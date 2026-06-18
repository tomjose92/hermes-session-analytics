"""Session Analytics dashboard plugin — backend API routes.

Mounted at /api/plugins/session-analytics/ by the Hermes dashboard plugin
system.  Provides cost analytics, tool usage breakdown, token metrics, and
Slack user attribution for sessions stored in state.db.

All queries use read-only SessionDB connections to avoid write-lock contention
with the running gateway.
"""
from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from hermes_constants import get_hermes_home
except ImportError:
    import os as _os

    def get_hermes_home() -> Path:  # type: ignore[misc]
        val = (_os.environ.get("HERMES_HOME") or "").strip()
        return Path(val) if val else Path.home() / ".hermes"

try:
    from fastapi import APIRouter, HTTPException, Query
except Exception:

    class APIRouter:  # type: ignore[no-redef]
        def get(self, *a, **kw):
            return lambda fn: fn

        def post(self, *a, **kw):
            return lambda fn: fn

    class HTTPException(Exception):  # type: ignore[no-redef]
        def __init__(self, status_code=500, detail=""):
            self.status_code = status_code
            self.detail = detail

    def Query(*a, **kw):  # type: ignore[misc]
        return kw.get("default")


log = logging.getLogger(__name__)
router = APIRouter()

# ---------------------------------------------------------------------------
# Time range helpers
# ---------------------------------------------------------------------------

def _compute_cutoff(
    days: Optional[int] = None,
    seconds: Optional[int] = None,
    since: Optional[float] = None,
    until: Optional[float] = None,
) -> tuple:
    """Return (cutoff_start, cutoff_end) as unix timestamps.

    Priority: explicit since/until > seconds > days (default 30).
    """
    now = time.time()
    if since is not None:
        start = since
    elif seconds is not None:
        start = now - seconds
    elif days is not None:
        start = now - (days * 86400)
    else:
        start = now - (30 * 86400)

    end = until if until is not None else now
    return (start, end)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _db_path() -> Path:
    return Path(get_hermes_home()) / "state.db"


def _connect() -> sqlite3.Connection:
    """Open a read-only connection to state.db."""
    path = _db_path()
    if not path.exists():
        raise HTTPException(status_code=503, detail="state.db not found")
    conn = sqlite3.connect(
        f"file:{path}?mode=ro",
        uri=True,
        check_same_thread=False,
        timeout=5.0,
        isolation_level=None,
    )
    conn.row_factory = sqlite3.Row
    return conn


def _rows_to_dicts(rows: list) -> List[Dict[str, Any]]:
    return [dict(r) for r in rows]


def _sessions_json_path() -> Path:
    return Path(get_hermes_home()) / "sessions" / "sessions.json"


_SLACK_USER_RE = re.compile(r"^U[A-Z0-9]{5,}$")

# Patterns for parsing structured prefixes from user message content
_THREAD_CTX_RE = re.compile(
    r"^\[Thread context — prior messages in this thread \(not yet in conversation history\):\]\n"
    r"(.*?)"
    r"\n\[End of thread context\]\n\n",
    re.DOTALL,
)
_REPLY_RE = re.compile(r'^\[Replying to: "(.*?)"\]\n\n', re.DOTALL)
_SENDER_RE = re.compile(r"^\[([^\]\n]+)\]\s+")


def _parse_user_message(content: str) -> Dict[str, Any]:
    """Parse structured prefixes from a user-role message.

    The gateway embeds thread context, reply-to quotes, and sender names
    directly in the message content.  This function strips them out and
    returns a single merged ``context`` field (for one collapsible block)
    plus the cleaned actual message.
    """
    result: Dict[str, Any] = {
        "context": None,
        "author": None,
    }
    text = content
    context_parts: List[str] = []

    reply_text: Optional[str] = None

    # Strip thread context (may appear before or after reply-to)
    m = _THREAD_CTX_RE.match(text)
    if m:
        context_parts.append(m.group(0).rstrip("\n"))
        text = text[m.end():]

    # Strip reply-to quote
    m = _REPLY_RE.match(text)
    if m:
        reply_text = m.group(1)
        text = text[m.end():]

    # Strip thread context that appears after reply-to
    m = _THREAD_CTX_RE.match(text)
    if m:
        ctx_block = m.group(0).rstrip("\n")
        if ctx_block not in context_parts:
            context_parts.append(ctx_block)
        text = text[m.end():]

    # Strip sender prefix
    m = _SENDER_RE.match(text)
    if m:
        result["author"] = m.group(1)
        text = text[m.end():]

    # Merge: add reply_to only if its content isn't already in thread_context
    if reply_text:
        already_in_ctx = any(reply_text in p for p in context_parts)
        if not already_in_ctx:
            context_parts.insert(0, "Replying to: " + reply_text)

    if context_parts:
        result["context"] = "\n\n".join(context_parts)
    result["content"] = text
    return result


def classify_user(user_id: str, source: str) -> str:
    """Classify a user_id as human, automation, cron, or system."""
    if source == "cron" or (user_id and user_id.startswith("cron:")):
        return "cron"
    if user_id and user_id.startswith("webhook:"):
        return "automation"
    if user_id and _SLACK_USER_RE.match(user_id):
        return "human"
    return "system"


def _load_sessions_routing() -> Dict[str, Any]:
    """Load the full sessions.json routing index."""
    sj_path = _sessions_json_path()
    try:
        if sj_path.exists():
            return json.loads(sj_path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _find_session_origin(session_id: str) -> Optional[Dict[str, Any]]:
    """Find the origin metadata for a session_id from sessions.json."""
    routing = _load_sessions_routing()
    for _key, entry in routing.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("session_id") == session_id:
            return entry.get("origin") if isinstance(entry.get("origin"), dict) else None
    return None


def _build_slack_link(origin: Dict[str, Any]) -> Optional[str]:
    """Construct a Slack archive link from origin fields."""
    if not origin or origin.get("platform") != "slack":
        return None
    chat_id = origin.get("chat_id")
    thread_id = origin.get("thread_id")
    if not chat_id:
        return None
    if thread_id:
        ts_clean = thread_id.replace(".", "")
        return f"https://app.slack.com/archives/{chat_id}/p{ts_clean}"
    return f"https://app.slack.com/archives/{chat_id}"


def _resolve_user_names() -> Dict[str, str]:
    """Resolve user_id → display_name from sessions.json origin.user_name.

    The gateway resolves Slack user IDs to display names at message receive
    time and stores the result in each SessionEntry's origin.user_name field.
    This covers all users who have ever messaged the bot.
    """
    names: Dict[str, str] = {}
    sj_path = _sessions_json_path()
    try:
        if sj_path.exists():
            routing = json.loads(sj_path.read_text(encoding="utf-8"))
            for _key, entry in routing.items():
                if not isinstance(entry, dict):
                    continue
                origin = entry.get("origin")
                if isinstance(origin, dict):
                    uid = origin.get("user_id")
                    uname = origin.get("user_name")
                    if uid and uname:
                        names[uid] = uname
    except Exception:
        pass
    return names


# ---------------------------------------------------------------------------
# GET /overview — aggregate dashboard stats
# ---------------------------------------------------------------------------

@router.get("/overview")
def get_overview(
    days: Optional[int] = Query(None, ge=1, le=365, description="Lookback window in days"),
    seconds: Optional[int] = Query(None, ge=1, description="Lookback window in seconds (overrides days)"),
    since: Optional[float] = Query(None, description="Unix timestamp start (custom range)"),
    until: Optional[float] = Query(None, description="Unix timestamp end (custom range)"),
):
    """High-level dashboard: totals, breakdowns by source/model, daily time-series."""
    conn = _connect()
    try:
        cutoff, cutoff_end = _compute_cutoff(days, seconds, since, until)

        rng = (cutoff, cutoff_end)

        totals = conn.execute(
            """
            SELECT
                COUNT(*)                     AS total_sessions,
                COALESCE(SUM(message_count), 0)   AS total_messages,
                COALESCE(SUM(tool_call_count), 0)  AS total_tool_calls,
                COALESCE(SUM(api_call_count), 0)   AS total_api_calls,
                COALESCE(SUM(input_tokens), 0)     AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0)    AS total_output_tokens,
                COALESCE(SUM(cache_read_tokens), 0)  AS total_cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write_tokens,
                COALESCE(SUM(reasoning_tokens), 0)   AS total_reasoning_tokens,
                COALESCE(SUM(estimated_cost_usd), 0)  AS total_estimated_cost
            FROM sessions
            WHERE started_at >= ? AND started_at <= ?
            """,
            rng,
        ).fetchone()

        by_source = _rows_to_dicts(conn.execute(
            """
            SELECT source,
                   COUNT(*) AS session_count,
                   COALESCE(SUM(estimated_cost_usd), 0) AS cost,
                   COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
            FROM sessions
            WHERE started_at >= ? AND started_at <= ?
            GROUP BY source
            ORDER BY cost DESC
            """,
            rng,
        ).fetchall())

        by_model = _rows_to_dicts(conn.execute(
            """
            SELECT model,
                   COUNT(*) AS session_count,
                   COALESCE(SUM(estimated_cost_usd), 0) AS cost,
                   COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
            FROM sessions
            WHERE started_at >= ? AND started_at <= ?
            GROUP BY model
            ORDER BY cost DESC
            """,
            rng,
        ).fetchall())

        daily = _rows_to_dicts(conn.execute(
            """
            SELECT date(started_at, 'unixepoch') AS day,
                   COUNT(*) AS sessions,
                   COALESCE(SUM(estimated_cost_usd), 0) AS cost,
                   COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                   COALESCE(SUM(message_count), 0) AS messages
            FROM sessions
            WHERE started_at >= ? AND started_at <= ?
            GROUP BY day
            ORDER BY day
            """,
            rng,
        ).fetchall())

        return {
            "totals": dict(totals),
            "by_source": by_source,
            "by_model": by_model,
            "daily": daily,
            "cutoff": cutoff,
            "cutoff_end": cutoff_end,
            "generated_at": int(time.time()),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /sessions — enhanced session list with filters and sorting
# ---------------------------------------------------------------------------

@router.get("/sessions")
def list_sessions(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    source: Optional[str] = Query(None, description="Filter by source: slack, cron, webhook, cli"),
    model: Optional[str] = Query(None, description="Filter by model name (substring match)"),
    user_id: Optional[str] = Query(None, description="Filter by user_id"),
    min_cost: Optional[float] = Query(None, ge=0, description="Minimum estimated cost"),
    days: Optional[int] = Query(None, ge=1, le=365, description="Only sessions within N days"),
    seconds: Optional[int] = Query(None, ge=1, description="Lookback window in seconds"),
    since: Optional[float] = Query(None, description="Unix timestamp start"),
    until: Optional[float] = Query(None, description="Unix timestamp end"),
    sort: str = Query("recent", description="Sort by: recent, cost, tokens, messages, duration"),
    active: Optional[bool] = Query(None, description="Filter by active (live) sessions"),
):
    """Enhanced session list with computed fields and flexible filtering."""
    conn = _connect()
    try:
        where_parts: List[str] = []
        params: List[Any] = []

        if source:
            where_parts.append("s.source = ?")
            params.append(source)
        if model:
            where_parts.append("s.model LIKE ?")
            params.append(f"%{model}%")
        if user_id:
            where_parts.append("s.user_id = ?")
            params.append(user_id)
        if min_cost is not None:
            where_parts.append("s.estimated_cost_usd >= ?")
            params.append(min_cost)
        if active is True:
            where_parts.append("s.ended_at IS NULL AND COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), s.started_at) > ?")
            params.append(time.time() - 1800)

        if since is not None or seconds is not None or days is not None:
            c_start, c_end = _compute_cutoff(days, seconds, since, until)
            where_parts.append("s.started_at >= ?")
            params.append(c_start)
            where_parts.append("s.started_at <= ?")
            params.append(c_end)

        where_sql = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

        sort_map = {
            "recent": "s.started_at DESC",
            "cost": "s.estimated_cost_usd DESC",
            "tokens": "(s.input_tokens + s.output_tokens) DESC",
            "messages": "s.message_count DESC",
            "duration": "(COALESCE(s.ended_at, ?) - s.started_at) DESC",
        }
        order_sql = sort_map.get(sort, "s.started_at DESC")
        order_params: List[Any] = []
        if sort == "duration":
            order_params.append(time.time())

        count_row = conn.execute(
            f"SELECT COUNT(*) AS n FROM sessions s {where_sql}",
            params,
        ).fetchone()
        total = count_row["n"]

        now = time.time()
        active_threshold = now - 1800  # 30 minutes

        rows = conn.execute(
            f"""
            SELECT
                s.id,
                s.source,
                s.user_id,
                s.model,
                s.title,
                s.started_at,
                s.ended_at,
                s.end_reason,
                s.message_count,
                s.tool_call_count,
                s.api_call_count,
                s.input_tokens,
                s.output_tokens,
                s.cache_read_tokens,
                s.cache_write_tokens,
                s.reasoning_tokens,
                s.estimated_cost_usd,
                s.actual_cost_usd,
                s.cost_status,
                s.billing_provider,
                s.parent_session_id,
                s.archived,
                COALESCE(s.ended_at, ?) - s.started_at AS duration_seconds,
                (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message_at
            FROM sessions s
            {where_sql}
            ORDER BY {order_sql}
            LIMIT ? OFFSET ?
            """,
            [now] + params + order_params + [limit, offset],
        ).fetchall()

        user_names = _resolve_user_names()
        sessions = []
        for r in rows:
            d = dict(r)
            total_tokens = (d.get("input_tokens") or 0) + (d.get("output_tokens") or 0)
            d["total_tokens"] = total_tokens
            mc = d.get("message_count") or 0
            d["tokens_per_message"] = round(total_tokens / mc, 1) if mc > 0 else 0
            last_msg = d.get("last_message_at") or d.get("started_at") or 0
            d["is_active"] = d.get("ended_at") is None and last_msg > active_threshold
            uid = d.get("user_id") or ""
            d["display_name"] = user_names.get(uid, uid)
            sessions.append(d)

        return {
            "sessions": sessions,
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /sessions/{id}/tools — per-session tool call breakdown
# ---------------------------------------------------------------------------

@router.get("/sessions/{session_id}/tools")
def session_tools(session_id: str):
    """Tool usage breakdown for a single session.

    Extracts tool names from messages with role='tool', groups by tool_name,
    and computes call count and average latency (time between the assistant's
    tool_call request and the tool result).
    """
    conn = _connect()
    try:
        session = conn.execute(
            "SELECT id FROM sessions WHERE id = ?", (session_id,),
        ).fetchone()
        if not session:
            raise HTTPException(status_code=404, detail=f"session {session_id} not found")

        messages = conn.execute(
            """
            SELECT id, role, tool_call_id, tool_name, tool_calls, timestamp
            FROM messages
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()

        # Build a map of tool_call_id -> assistant request timestamp
        call_request_times: Dict[str, float] = {}
        for m in messages:
            if m["role"] == "assistant" and m["tool_calls"]:
                try:
                    calls = json.loads(m["tool_calls"]) if isinstance(m["tool_calls"], str) else m["tool_calls"]
                    if isinstance(calls, list):
                        for call in calls:
                            call_id = call.get("id") if isinstance(call, dict) else None
                            if call_id:
                                call_request_times[call_id] = m["timestamp"] or 0
                except (json.JSONDecodeError, TypeError):
                    pass

        tool_stats: Dict[str, Dict[str, Any]] = {}
        for m in messages:
            if m["role"] != "tool":
                continue
            name = m["tool_name"] or "unknown"
            if name not in tool_stats:
                tool_stats[name] = {"name": name, "count": 0, "total_latency": 0, "latency_count": 0}
            tool_stats[name]["count"] += 1

            # Compute latency if we can match the request
            call_id = m["tool_call_id"]
            if call_id and call_id in call_request_times and m["timestamp"]:
                latency = m["timestamp"] - call_request_times[call_id]
                if 0 < latency < 600:  # sanity: under 10 minutes
                    tool_stats[name]["total_latency"] += latency
                    tool_stats[name]["latency_count"] += 1

        result = []
        for ts in sorted(tool_stats.values(), key=lambda x: x["count"], reverse=True):
            avg_latency = (
                round(ts["total_latency"] / ts["latency_count"], 3)
                if ts["latency_count"] > 0 else None
            )
            result.append({
                "name": ts["name"],
                "count": ts["count"],
                "avg_latency_seconds": avg_latency,
            })

        return {
            "session_id": session_id,
            "tools": result,
            "total_tool_calls": sum(t["count"] for t in result),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /sessions/{id}/detail — full session detail for expandable view
# ---------------------------------------------------------------------------

@router.get("/sessions/{session_id}/detail")
def session_detail(session_id: str):
    """Combined detail view: session metadata, conversation, tool breakdown, and skill triggers."""
    conn = _connect()
    try:
        session = conn.execute(
            "SELECT * FROM sessions WHERE id = ?", (session_id,),
        ).fetchone()
        if not session:
            raise HTTPException(status_code=404, detail=f"session {session_id} not found")

        messages = conn.execute(
            """
            SELECT id, role, content, tool_name, tool_calls, tool_call_id,
                   timestamp, token_count, finish_reason
            FROM messages
            WHERE session_id = ? AND COALESCE(active, 1) = 1
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()

        conversation = []
        tool_usage: Dict[str, int] = {}
        skills: List[str] = []

        for m in messages:
            entry: Dict[str, Any] = {
                "role": m["role"],
                "timestamp": m["timestamp"],
                "tokens": m["token_count"],
            }

            content = m["content"] or ""

            if m["role"] == "user":
                parsed = _parse_user_message(content)
                entry["content"] = parsed["content"]
                if parsed["author"]:
                    entry["author"] = parsed["author"]
                if parsed["context"]:
                    entry["context"] = parsed["context"]
            elif m["role"] == "assistant":
                if "Skill " in content and "triggered" in content:
                    for line in content.split("\n"):
                        stripped = line.strip()
                        if "Skill " in stripped and "triggered" in stripped:
                            skills.append(stripped)

                tc_raw = m["tool_calls"]
                if tc_raw:
                    try:
                        calls = json.loads(tc_raw) if isinstance(tc_raw, str) else tc_raw
                        if isinstance(calls, list):
                            names = []
                            for c in calls:
                                fn = (c.get("function") or {}).get("name") if isinstance(c, dict) else None
                                if fn:
                                    names.append(fn)
                                    tool_usage[fn] = tool_usage.get(fn, 0) + 1
                            entry["tool_calls"] = names
                    except (json.JSONDecodeError, TypeError):
                        pass

                entry["content"] = content or None
            elif m["role"] == "tool":
                name = m["tool_name"] or "unknown"
                tool_usage[name] = tool_usage.get(name, 0) + 1
                entry["tool_name"] = name
                entry["content"] = content or None

            conversation.append(entry)

        tools_sorted = sorted(
            [{"name": k, "count": v} for k, v in tool_usage.items()],
            key=lambda x: x["count"],
            reverse=True,
        )

        sess = dict(session)
        uid = sess.get("user_id") or ""
        src = sess.get("source") or ""
        itype = classify_user(uid, src)

        origin = _find_session_origin(session_id)
        user_names = _resolve_user_names()

        if itype == "human":
            iname = (origin or {}).get("user_name") or user_names.get(uid, uid)
        elif itype == "cron" and uid.startswith("cron:"):
            iname = uid[5:]
        elif itype == "automation" and uid.startswith("webhook:"):
            iname = uid[8:]
        else:
            iname = uid or src

        slack_link = _build_slack_link(origin) if origin else None

        return {
            "session": sess,
            "conversation": conversation,
            "tools": tools_sorted,
            "total_tool_calls": sum(t["count"] for t in tools_sorted),
            "skills": skills,
            "message_count": len(conversation),
            "initiator_name": iname,
            "initiator_type": itype,
            "slack_link": slack_link,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /sessions/{id}/timeline — per-session message timeline with latencies
# ---------------------------------------------------------------------------

@router.get("/sessions/{session_id}/timeline")
def session_timeline(session_id: str):
    """Ordered timeline of messages in a session with inter-message latency."""
    conn = _connect()
    try:
        session = conn.execute(
            "SELECT id FROM sessions WHERE id = ?", (session_id,),
        ).fetchone()
        if not session:
            raise HTTPException(status_code=404, detail=f"session {session_id} not found")

        messages = conn.execute(
            """
            SELECT id, role, tool_name, timestamp, token_count, finish_reason
            FROM messages
            WHERE session_id = ?
              AND COALESCE(active, 1) = 1
            ORDER BY id ASC
            """,
            (session_id,),
        ).fetchall()

        timeline = []
        prev_ts = None
        for m in messages:
            d = dict(m)
            ts = d.get("timestamp")
            if ts and prev_ts:
                d["latency_seconds"] = round(ts - prev_ts, 3)
            else:
                d["latency_seconds"] = None
            prev_ts = ts
            timeline.append(d)

        return {
            "session_id": session_id,
            "timeline": timeline,
            "message_count": len(timeline),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /costs — cost analytics
# ---------------------------------------------------------------------------

@router.get("/costs")
def cost_analytics(
    days: Optional[int] = Query(None, ge=1, le=365),
    seconds: Optional[int] = Query(None, ge=1),
    since: Optional[float] = Query(None),
    until: Optional[float] = Query(None),
    top_n: int = Query(20, ge=1, le=100, description="Number of top sessions to return"),
    top_source: Optional[str] = Query(None, description="Filter top sessions by source"),
):
    """Cost breakdown by model, source, user, and day. Plus top-N expensive sessions."""
    conn = _connect()
    try:
        cutoff, cutoff_end = _compute_cutoff(days, seconds, since, until)
        rng = (cutoff, cutoff_end)

        by_model = _rows_to_dicts(conn.execute(
            """
            SELECT model,
                   COUNT(*) AS session_count,
                   COALESCE(SUM(estimated_cost_usd), 0) AS total_cost,
                   COALESCE(AVG(estimated_cost_usd), 0) AS avg_cost,
                   COALESCE(MAX(estimated_cost_usd), 0) AS max_cost
            FROM sessions WHERE started_at >= ? AND started_at <= ?
            GROUP BY model ORDER BY total_cost DESC
            """,
            rng,
        ).fetchall())

        by_source = _rows_to_dicts(conn.execute(
            """
            SELECT source,
                   COUNT(*) AS session_count,
                   COALESCE(SUM(estimated_cost_usd), 0) AS total_cost,
                   COALESCE(AVG(estimated_cost_usd), 0) AS avg_cost
            FROM sessions WHERE started_at >= ? AND started_at <= ?
            GROUP BY source ORDER BY total_cost DESC
            """,
            rng,
        ).fetchall())

        by_user = _rows_to_dicts(conn.execute(
            """
            SELECT user_id,
                   COUNT(*) AS session_count,
                   COALESCE(SUM(estimated_cost_usd), 0) AS total_cost,
                   COALESCE(AVG(estimated_cost_usd), 0) AS avg_cost
            FROM sessions
            WHERE started_at >= ? AND started_at <= ? AND user_id IS NOT NULL
            GROUP BY user_id ORDER BY total_cost DESC
            """,
            rng,
        ).fetchall())

        daily = _rows_to_dicts(conn.execute(
            """
            SELECT date(started_at, 'unixepoch') AS day,
                   COALESCE(SUM(estimated_cost_usd), 0) AS cost,
                   COUNT(*) AS sessions
            FROM sessions WHERE started_at >= ? AND started_at <= ?
            GROUP BY day ORDER BY day
            """,
            rng,
        ).fetchall())

        top_where = "started_at >= ? AND started_at <= ? AND estimated_cost_usd > 0"
        top_params: List[Any] = [cutoff, cutoff_end]
        if top_source:
            top_where += " AND source = ?"
            top_params.append(top_source)
        top_params.append(top_n)
        top_sessions = _rows_to_dicts(conn.execute(
            f"""
            SELECT id, source, user_id, model, title, started_at,
                   estimated_cost_usd, message_count, tool_call_count,
                   input_tokens, output_tokens
            FROM sessions
            WHERE {top_where}
            ORDER BY estimated_cost_usd DESC
            LIMIT ?
            """,
            top_params,
        ).fetchall())

        user_names = _resolve_user_names()
        for row in by_user:
            uid = row.get("user_id") or ""
            if uid in user_names:
                row["display_name"] = user_names[uid]
            elif uid.startswith("cron:"):
                row["display_name"] = uid[5:]
            elif uid.startswith("webhook:"):
                row["display_name"] = uid[8:]
            else:
                row["display_name"] = uid

        # Cost by platform caller grouped by name (webhooks + crons)
        by_platform_raw = _rows_to_dicts(conn.execute(
            """
            SELECT COALESCE(user_id, source || ':unknown') AS caller_id,
                   source,
                   COUNT(*) AS session_count,
                   COALESCE(SUM(estimated_cost_usd), 0) AS total_cost,
                   COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
            FROM sessions
            WHERE started_at >= ? AND started_at <= ?
              AND (user_id LIKE 'webhook:%%' OR source = 'cron')
            GROUP BY caller_id
            ORDER BY total_cost DESC
            """,
            rng,
        ).fetchall())
        by_platform = []
        for row in by_platform_raw:
            cid = row.get("caller_id") or ""
            if cid.startswith("cron:"):
                label = cid[5:]
            elif cid.startswith("webhook:"):
                label = cid[8:]
            else:
                label = cid
            row["platform_id"] = label
            by_platform.append(row)

        return {
            "by_model": by_model,
            "by_source": by_source,
            "by_user": by_user,
            "by_platform": by_platform,
            "daily": daily,
            "top_sessions": top_sessions,
            "cutoff": cutoff,
            "cutoff_end": cutoff_end,
            "generated_at": int(time.time()),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /tools — global tool usage analytics
# ---------------------------------------------------------------------------

@router.get("/tools")
def tool_analytics(
    days: Optional[int] = Query(None, ge=1, le=365),
    seconds: Optional[int] = Query(None, ge=1),
    since: Optional[float] = Query(None),
    until: Optional[float] = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    """Aggregate tool usage across all sessions: call counts, avg latency."""
    conn = _connect()
    try:
        cutoff, cutoff_end = _compute_cutoff(days, seconds, since, until)

        rows = conn.execute(
            """
            SELECT m.tool_name, COUNT(*) AS call_count
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE m.role = 'tool'
              AND m.tool_name IS NOT NULL
              AND s.started_at >= ? AND s.started_at <= ?
            GROUP BY m.tool_name
            ORDER BY call_count DESC
            LIMIT ?
            """,
            (cutoff, cutoff_end, limit),
        ).fetchall()

        tools = []
        for r in rows:
            tools.append({
                "name": r["tool_name"],
                "call_count": r["call_count"],
            })

        return {
            "tools": tools,
            "days": days,
            "total_distinct_tools": len(tools),
            "generated_at": int(time.time()),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /users — Slack user attribution
# ---------------------------------------------------------------------------

@router.get("/users")
def user_analytics(
    days: Optional[int] = Query(None, ge=1, le=365),
    seconds: Optional[int] = Query(None, ge=1),
    since: Optional[float] = Query(None),
    until: Optional[float] = Query(None),
):
    """Per-user session and cost breakdown, enriched with Slack display names
    and classified by user type (human, automation, cron, system)."""
    conn = _connect()
    try:
        cutoff, cutoff_end = _compute_cutoff(days, seconds, since, until)

        rows = _rows_to_dicts(conn.execute(
            """
            SELECT user_id,
                   COUNT(*) AS session_count,
                   COALESCE(SUM(estimated_cost_usd), 0) AS total_cost,
                   COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                   COALESCE(SUM(message_count), 0) AS total_messages,
                   COALESCE(SUM(tool_call_count), 0) AS total_tool_calls,
                   MAX(started_at) AS last_active
            FROM sessions
            WHERE started_at >= ? AND started_at <= ? AND user_id IS NOT NULL
            GROUP BY user_id
            ORDER BY total_cost DESC
            """,
            (cutoff, cutoff_end),
        ).fetchall())

        # Determine dominant source per user_id for classification
        source_rows = conn.execute(
            """
            SELECT user_id, source, COUNT(*) AS cnt
            FROM sessions
            WHERE started_at >= ? AND started_at <= ? AND user_id IS NOT NULL
            GROUP BY user_id, source
            ORDER BY cnt DESC
            """,
            (cutoff, cutoff_end),
        ).fetchall()
        user_source: Dict[str, str] = {}
        for sr in source_rows:
            uid = sr["user_id"]
            if uid not in user_source:
                user_source[uid] = sr["source"] or ""

        user_names = _resolve_user_names()
        for row in rows:
            uid = row.get("user_id") or ""
            utype = classify_user(uid, user_source.get(uid, ""))
            row["user_type"] = utype
            if uid in user_names:
                row["display_name"] = user_names[uid]
            elif utype == "cron" and uid.startswith("cron:"):
                row["display_name"] = uid[5:]  # strip "cron:" prefix
            elif utype == "automation" and uid.startswith("webhook:"):
                row["display_name"] = uid[8:]  # strip "webhook:" prefix
            else:
                row["display_name"] = uid

        return {
            "users": rows,
            "cutoff": cutoff,
            "cutoff_end": cutoff_end,
            "generated_at": int(time.time()),
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /models — model usage analytics
# ---------------------------------------------------------------------------

@router.get("/models")
def model_analytics(
    days: Optional[int] = Query(None, ge=1, le=365),
    seconds: Optional[int] = Query(None, ge=1),
    since: Optional[float] = Query(None),
    until: Optional[float] = Query(None),
):
    """Per-model usage breakdown: sessions, cost, tokens, avg latency."""
    conn = _connect()
    try:
        cutoff, cutoff_end = _compute_cutoff(days, seconds, since, until)

        rows = _rows_to_dicts(conn.execute(
            """
            SELECT model,
                   billing_provider,
                   COUNT(*) AS session_count,
                   COALESCE(SUM(estimated_cost_usd), 0) AS total_cost,
                   COALESCE(AVG(estimated_cost_usd), 0) AS avg_cost_per_session,
                   COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                   COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
                   COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning_tokens,
                   COALESCE(SUM(message_count), 0) AS total_messages,
                   COALESCE(SUM(tool_call_count), 0) AS total_tool_calls,
                   COALESCE(SUM(api_call_count), 0) AS total_api_calls
            FROM sessions
            WHERE started_at >= ? AND started_at <= ?
            GROUP BY model, billing_provider
            ORDER BY total_cost DESC
            """,
            (cutoff, cutoff_end),
        ).fetchall())

        return {
            "models": rows,
            "cutoff": cutoff,
            "cutoff_end": cutoff_end,
            "generated_at": int(time.time()),
        }
    finally:
        conn.close()
