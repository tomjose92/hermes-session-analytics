/**
 * Hermes Session Analytics — Dashboard Plugin
 *
 * Cost analytics, tool usage breakdown, token metrics, and user attribution
 * for Hermes sessions. Calls the plugin backend at /api/plugins/session-analytics/.
 *
 * Plain IIFE, no build step. Uses window.__HERMES_PLUGIN_SDK__ for React +
 * shadcn primitives.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;

  var React = SDK.React;
  var h = React.createElement;
  var components = SDK.components || {};
  var Card = components.Card || "div";
  var CardContent = components.CardContent || "div";
  var Badge = components.Badge || "span";
  var Button = components.Button || "button";
  var Select = components.Select || "select";
  var SelectOption = components.SelectOption || "option";
  var hooks = SDK.hooks || React;
  var useState = hooks.useState || React.useState;
  var useEffect = hooks.useEffect || React.useEffect;
  var useCallback = hooks.useCallback || React.useCallback;
  var useMemo = hooks.useMemo || React.useMemo;
  var cn = (SDK.utils && SDK.utils.cn) || function () {
    return Array.prototype.filter.call(arguments, Boolean).join(" ");
  };

  var API = "/api/plugins/session-analytics";

  function fetchJSON(path, params) {
    var url = API + path;
    if (params) {
      var qs = Object.keys(params)
        .filter(function (k) { return params[k] != null && params[k] !== ""; })
        .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
        .join("&");
      if (qs) url += "?" + qs;
    }
    return fetch(url, {
      headers: { Authorization: "Bearer " + (window.__HERMES_SESSION_TOKEN__ || "") },
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function fmtCost(v) {
    if (v == null || v === 0) return "$0.000";
    return "$" + v.toFixed(3);
  }

  function fmtTokens(v) {
    if (v == null) return "0";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(v);
  }

  function fmtDuration(sec) {
    if (sec == null || sec <= 0) return "-";
    if (sec < 60) return Math.round(sec) + "s";
    if (sec < 3600) return Math.round(sec / 60) + "m";
    return (sec / 3600).toFixed(1) + "h";
  }

  function fmtDate(ts) {
    if (!ts) return "-";
    var d = new Date(ts * 1000);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // ─── Time Range Presets ────────────────────────────────────────────
  var TIME_RANGES = [
    { id: "5m",  label: "5m",   seconds: 300 },
    { id: "15m", label: "15m",  seconds: 900 },
    { id: "1h",  label: "1h",   seconds: 3600 },
    { id: "3h",  label: "3h",   seconds: 10800 },
    { id: "1d",  label: "1d",   seconds: 86400 },
    { id: "1w",  label: "1w",   seconds: 604800 },
    { id: "2w",  label: "2w",   seconds: 1209600 },
    { id: "1M",  label: "1M",   seconds: 2592000 },
    { id: "6M",  label: "6M",   seconds: 15552000 },
    { id: "custom", label: "Custom", seconds: null },
  ];

  function timeRangeToParams(rangeId, customSince, customUntil) {
    if (rangeId === "custom" && customSince) {
      var params = { since: Math.floor(customSince / 1000) };
      if (customUntil) params.until = Math.floor(customUntil / 1000);
      return params;
    }
    var preset = TIME_RANGES.find(function (r) { return r.id === rangeId; });
    if (preset && preset.seconds) return { seconds: preset.seconds };
    return { seconds: 2592000 };
  }

  function fmtDateInput(d) {
    if (!d) return "";
    var dt = new Date(d);
    var y = dt.getFullYear();
    var m = String(dt.getMonth() + 1).padStart(2, "0");
    var day = String(dt.getDate()).padStart(2, "0");
    var hh = String(dt.getHours()).padStart(2, "0");
    var mm = String(dt.getMinutes()).padStart(2, "0");
    return y + "-" + m + "-" + day + "T" + hh + ":" + mm;
  }

  // ─── TimePicker Component ─────────────────────────────────────────
  function TimePicker(props) {
    var selected = props.selected;
    var onChange = props.onChange;
    var customSince = props.customSince;
    var customUntil = props.customUntil;
    var onCustomChange = props.onCustomChange;

    return h("div", { className: "sa-time-picker" },
      h("div", { className: "sa-time-presets" },
        TIME_RANGES.map(function (r) {
          var isActive = selected === r.id;
          return h(Button, {
            key: r.id,
            variant: isActive ? "default" : "outline",
            size: "sm",
            onClick: function () { onChange(r.id); },
            className: "sa-time-btn" + (isActive ? " sa-time-btn--active" : ""),
            "aria-pressed": isActive,
          }, r.label);
        })
      ),
      selected === "custom" ? h("div", { className: "sa-custom-range" },
        h("label", null, "From: "),
        h("input", {
          type: "datetime-local",
          className: "sa-date-input",
          value: fmtDateInput(customSince),
          onChange: function (e) {
            var v = e.target.value ? new Date(e.target.value).getTime() : null;
            onCustomChange(v, customUntil);
          },
        }),
        h("label", null, " To: "),
        h("input", {
          type: "datetime-local",
          className: "sa-date-input",
          value: fmtDateInput(customUntil),
          onChange: function (e) {
            var v = e.target.value ? new Date(e.target.value).getTime() : null;
            onCustomChange(customSince, v);
          },
        })
      ) : null
    );
  }

  // Hook: manages time range state for a tab.
  // Returns a stable `paramsKey` string for use in useEffect deps and
  // a `getParams()` function that builds the query object on demand.
  function useTimeRange(defaultRange) {
    var _r = useState(defaultRange || "1M"), rangeId = _r[0], setRangeId = _r[1];
    var _cs = useState(null), customSince = _cs[0], setCustomSince = _cs[1];
    var _cu = useState(null), customUntil = _cu[0], setCustomUntil = _cu[1];

    var paramsKey = useMemo(function () {
      return rangeId + ":" + (customSince || "") + ":" + (customUntil || "");
    }, [rangeId, customSince, customUntil]);

    var params = useMemo(function () {
      return timeRangeToParams(rangeId, customSince, customUntil);
    }, [paramsKey]);

    function onCustomChange(s, u) {
      setCustomSince(s);
      setCustomUntil(u);
    }

    return {
      rangeId: rangeId,
      setRangeId: setRangeId,
      customSince: customSince,
      customUntil: customUntil,
      onCustomChange: onCustomChange,
      params: params,
      paramsKey: paramsKey,
    };
  }

  // ─── Stat Card ──────────────────────────────────────────────────────
  function StatCard(props) {
    return h(Card, { className: "sa-stat-card" },
      h(CardContent, { className: "sa-stat-content" },
        h("div", { className: "sa-stat-label" }, props.label),
        h("div", { className: "sa-stat-value" }, props.value),
        props.sub ? h("div", { className: "sa-stat-sub" }, props.sub) : null
      )
    );
  }

  // ─── Hover tooltip helper (shared by charts) ──────────────────────
  // Tracks a cursor-anchored tooltip positioned relative to a chart
  // container. Returns a ref to attach to the container, the current tip
  // state, and handlers to show/clear it on individual data cells.
  var useRef = (hooks && hooks.useRef) || React.useRef;
  function useHoverTip() {
    var ref = useRef(null);
    var _t = useState(null), tip = _t[0], setTip = _t[1];
    function show(e, text) {
      var el = ref.current;
      if (!el) return;
      var rect = el.getBoundingClientRect();
      setTip({ text: text, x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
    function clear() { setTip(null); }
    return { ref: ref, tip: tip, show: show, clear: clear };
  }

  function tipNode(tip) {
    if (!tip) return null;
    return h("div", {
      className: "sa-tooltip",
      style: { left: tip.x + "px", top: tip.y + "px" },
    }, tip.text);
  }

  // ─── Simple Bar Chart (pure CSS, no Chart.js dependency) ───────────
  function BarChart(props) {
    var data = props.data || [];
    var labelKey = props.labelKey || "label";
    var valueKey = props.valueKey || "value";
    var ht = useHoverTip();
    var maxVal = Math.max.apply(null, data.map(function (d) { return d[valueKey] || 0; }));
    if (maxVal === 0) maxVal = 1;

    return h("div", { className: "sa-bar-chart sa-chart-hover", ref: ht.ref },
      data.map(function (d, i) {
        var pct = ((d[valueKey] || 0) / maxVal) * 100;
        var label = d[labelKey] || "";
        var display = props.formatValue ? props.formatValue(d[valueKey]) : String(d[valueKey] || 0);
        var text = label + ": " + display;
        return h("div", {
          key: i,
          className: "sa-bar-row",
          title: text,
          onMouseEnter: function (e) { ht.show(e, text); },
          onMouseMove: function (e) { ht.show(e, text); },
          onMouseLeave: ht.clear,
        },
          h("div", { className: "sa-bar-label", title: label }, label),
          h("div", { className: "sa-bar-track" },
            h("div", { className: "sa-bar-fill", style: { width: pct + "%" } })
          ),
          h("div", { className: "sa-bar-value" }, display)
        );
      }),
      tipNode(ht.tip)
    );
  }

  // ─── Sparkline (pure CSS bars with full-height hover targets) ──────
  function Sparkline(props) {
    var data = props.data || [];
    var valueKey = props.valueKey || "value";
    var ht = useHoverTip();
    var maxVal = Math.max.apply(null, data.map(function (d) { return d[valueKey] || 0; }));
    if (maxVal === 0) maxVal = 1;

    function fmt(v) { return props.formatValue ? props.formatValue(v) : String(v); }

    return h("div", { className: "sa-sparkline sa-chart-hover", ref: ht.ref },
      data.map(function (d, i) {
        var pct = ((d[valueKey] || 0) / maxVal) * 100;
        var text = (d.day || "") + " · " + fmt(d[valueKey] || 0);
        return h("div", {
          key: i,
          className: "sa-spark-col",
          title: text,
          onMouseEnter: function (e) { ht.show(e, text); },
          onMouseMove: function (e) { ht.show(e, text); },
          onMouseLeave: ht.clear,
        },
          h("div", { className: "sa-spark-bar", style: { height: Math.max(pct, 1) + "%" } })
        );
      }),
      tipNode(ht.tip)
    );
  }

  // ─── Overview Tab ──────────────────────────────────────────────────
  function OverviewTab(props) {
    var _s = useState(null), data = _s[0], setData = _s[1];
    var _e = useState(null), err = _e[0], setErr = _e[1];
    var _l = useState(false), loading = _l[0], setLoading = _l[1];
    var tr = useTimeRange("1M");

    useEffect(function () {
      setLoading(true);
      setErr(null);
      fetchJSON("/overview", tr.params)
        .then(function (d) { setData(d); setLoading(false); })
        .catch(function (e) { setErr(e.message); setLoading(false); });
    }, [tr.params, props.refreshKey]);

    if (err) return h("div", { className: "sa-error" }, "Error: " + err);
    if (!data || loading) return h("div", { className: "sa-loading" }, "Loading...");

    var t = data.totals;
    return h("div", { className: "sa-overview" },
      h("div", { className: "sa-header" },
        h("h2", null, "Session Analytics"),
        h(TimePicker, {
          selected: tr.rangeId,
          onChange: tr.setRangeId,
          customSince: tr.customSince,
          customUntil: tr.customUntil,
          onCustomChange: tr.onCustomChange,
        })
      ),

      h("div", { className: "sa-stats-grid" },
        h(StatCard, { label: "Sessions", value: t.total_sessions }),
        h(StatCard, { label: "Total Cost", value: fmtCost(t.total_estimated_cost) }),
        h(StatCard, { label: "Input Tokens", value: fmtTokens(t.total_input_tokens) }),
        h(StatCard, { label: "Output Tokens", value: fmtTokens(t.total_output_tokens) }),
        h(StatCard, { label: "Cache Read", value: fmtTokens(t.total_cache_read_tokens) }),
        h(StatCard, { label: "Tool Calls", value: t.total_tool_calls.toLocaleString() }),
        h(StatCard, { label: "API Calls", value: t.total_api_calls.toLocaleString() }),
        h(StatCard, { label: "Messages", value: t.total_messages.toLocaleString() })
      ),

      h("div", { className: "sa-charts-row" },
        h(Card, { className: "sa-chart-card" },
          h(CardContent, null,
            h("h3", null, "Daily Cost"),
            h(Sparkline, { data: data.daily, valueKey: "cost", formatValue: fmtCost })
          )
        ),
        h(Card, { className: "sa-chart-card" },
          h(CardContent, null,
            h("h3", null, "Daily Sessions"),
            h(Sparkline, { data: data.daily, valueKey: "sessions", formatValue: String })
          )
        )
      ),

      h("div", { className: "sa-charts-row" },
        h(Card, { className: "sa-chart-card" },
          h(CardContent, null,
            h("h3", null, "Cost by Model"),
            h(BarChart, {
              data: data.by_model.slice(0, 10),
              labelKey: "model",
              valueKey: "cost",
              formatValue: fmtCost,
            })
          )
        ),
        h(Card, { className: "sa-chart-card" },
          h(CardContent, null,
            h("h3", null, "Cost by Source"),
            h(BarChart, {
              data: data.by_source,
              labelKey: "source",
              valueKey: "cost",
              formatValue: fmtCost,
            })
          )
        )
      )
    );
  }

  // ─── Collapsible Text ─────────────────────────────────────────────
  function CollapsibleText(props) {
    var text = props.text || "";
    var previewLen = props.previewLen || 300;
    var extraClass = props.className || "";
    var _open = useState(false), isOpen = _open[0], setOpen = _open[1];
    var needsCollapse = text.length > previewLen;
    var cls = ("sa-msg-content" + (extraClass ? " " + extraClass : "")).trim();

    if (!needsCollapse) {
      return h("div", { className: cls }, text);
    }

    return h("div", { className: cls },
      isOpen ? text : text.substring(0, previewLen) + "...",
      h("span", {
        className: "sa-toggle-btn",
        onClick: function (e) { e.stopPropagation(); setOpen(!isOpen); },
      }, isOpen ? "Show less" : "Show more")
    );
  }

  // ─── Session Detail (expanded view) ────────────────────────────────
  function SessionDetail(props) {
    var sessionId = props.sessionId;
    var _d = useState(null), detail = _d[0], setDetail = _d[1];
    var _e = useState(null), err = _e[0], setErr = _e[1];
    var _tab = useState("conversation"), tab = _tab[0], setTab = _tab[1];

    useEffect(function () {
      setDetail(null);
      setErr(null);
      fetchJSON("/sessions/" + sessionId + "/detail")
        .then(setDetail)
        .catch(function (e) { setErr(e.message); });
    }, [sessionId]);

    if (err) return h("div", { className: "sa-detail-error" }, "Failed to load: " + err);
    if (!detail) return h("div", { className: "sa-detail-loading" }, "Loading detail...");

    var sess = detail.session || {};
    var conv = detail.conversation || [];
    var tools = detail.tools || [];
    var skills = detail.skills || [];
    var initiatorName = detail.initiator_name || sess.user_id || "User";
    var initiatorType = detail.initiator_type || "system";
    var slackLink = detail.slack_link;

    function msgAuthor(m) {
      if (m.role === "assistant") return "Hermes";
      if (m.role === "user") return m.author || initiatorName;
      return m.role;
    }

    var userMsgs = conv.filter(function (m) { return m.role === "user"; });
    var assistantMsgs = conv.filter(function (m) { return m.role === "assistant"; });
    var toolMsgs = conv.filter(function (m) { return m.role === "tool"; });

    var tabs = [
      { id: "conversation", label: "Conversation (" + (userMsgs.length + assistantMsgs.length) + ")" },
      { id: "tools", label: "Tools (" + detail.total_tool_calls + ")" },
      { id: "info", label: "Info" },
    ];

    function fmtTs(ts) {
      if (!ts) return "";
      var d = new Date(ts * 1000);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    return h("div", { className: "sa-detail" },
      h("div", { className: "sa-detail-tabs" },
        tabs.map(function (t) {
          return h("span", {
            key: t.id,
            className: "sa-detail-tab" + (tab === t.id ? " sa-detail-tab-active" : ""),
            onClick: function () { setTab(t.id); },
          }, t.label);
        }),
        slackLink ? h("a", {
          href: slackLink,
          target: "_blank",
          rel: "noopener noreferrer",
          className: "sa-slack-link",
          onClick: function (e) { e.stopPropagation(); },
        }, "Open in Slack ↗") : null
      ),

      tab === "conversation" ? h("div", { className: "sa-detail-conv" },
        conv.length === 0
          ? h("div", { className: "sa-detail-empty" }, "No messages")
          : (function () {
              var seenContext = false;
              return conv.filter(function (m) { return m.role === "user" || m.role === "assistant"; }).map(function (m, i) {
                var showCtx = m.context && !seenContext;
                if (m.context) seenContext = true;
                return h("div", { key: i, className: "sa-msg sa-msg-" + m.role },
                  h("div", { className: "sa-msg-header" },
                    h("span", { className: "sa-msg-role" }, msgAuthor(m)),
                    h("span", { className: "sa-msg-time" }, fmtTs(m.timestamp)),
                    m.tokens ? h("span", { className: "sa-msg-tokens" }, m.tokens + " tok") : null,
                    m.tool_calls ? h("span", { className: "sa-msg-tools" }, "→ " + m.tool_calls.join(", ")) : null
                  ),
                  showCtx ? h(CollapsibleText, {
                    text: m.context,
                    previewLen: 150,
                    className: "sa-thread-context",
                  }) : null,
                  m.content ? h(CollapsibleText, { text: m.content, previewLen: m.role === "user" ? 400 : 600 }) : null
                );
              });
            })()
      ) : null,

      tab === "tools" ? h("div", { className: "sa-detail-tools" },
        skills.length > 0 ? h("div", { className: "sa-detail-skills" },
          h("h4", null, "Skills Triggered"),
          skills.map(function (s, i) { return h("div", { key: i, className: "sa-skill-line" }, s); })
        ) : null,
        tools.length > 0 ? h("div", null,
          h("h4", null, "Tool Usage"),
          h("table", { className: "sa-table sa-compact" },
            h("thead", null,
              h("tr", null,
                h("th", null, "Tool"),
                h("th", { className: "sa-num" }, "Calls")
              )
            ),
            h("tbody", null,
              tools.map(function (t) {
                return h("tr", { key: t.name },
                  h("td", null, t.name),
                  h("td", { className: "sa-num" }, t.count)
                );
              })
            )
          )
        ) : h("div", { className: "sa-detail-empty" }, "No tool calls"),
        toolMsgs.length > 0 ? h("div", { className: "sa-detail-tool-log" },
          h("h4", null, "Tool Call Log"),
          toolMsgs.slice(0, 50).map(function (m, i) {
            return h("div", { key: i, className: "sa-tool-entry" },
              h("span", { className: "sa-tool-time" }, fmtTs(m.timestamp)),
              h("span", { className: "sa-tool-name" }, m.tool_name || "unknown"),
              m.content ? h(CollapsibleText, { text: m.content, previewLen: 150 }) : null
            );
          })
        ) : null
      ) : null,

      tab === "info" ? h("div", { className: "sa-detail-info" },
        h("table", { className: "sa-table sa-compact" },
          h("tbody", null,
            [
              ["Session ID", sess.id],
              ["Source", sess.source],
              ["User", sess.user_id],
              ["Model", sess.model],
              ["Title", sess.title],
              ["Started", fmtDate(sess.started_at)],
              ["Ended", sess.ended_at ? fmtDate(sess.ended_at) : "(active)"],
              ["End Reason", sess.end_reason],
              ["Duration", fmtDuration(sess.ended_at ? sess.ended_at - sess.started_at : null)],
              ["Messages", sess.message_count],
              ["Tool Calls", sess.tool_call_count],
              ["API Calls", sess.api_call_count],
              ["Input Tokens", fmtTokens(sess.input_tokens)],
              ["Output Tokens", fmtTokens(sess.output_tokens)],
              ["Cache Read", fmtTokens(sess.cache_read_tokens)],
              ["Estimated Cost", fmtCost(sess.estimated_cost_usd)],
              ["Billing Provider", sess.billing_provider],
              ["Parent Session", sess.parent_session_id],
            ].filter(function (r) { return r[1] != null && r[1] !== ""; }).map(function (r) {
              return h("tr", { key: r[0] },
                h("td", { className: "sa-info-label" }, r[0]),
                h("td", null, String(r[1]))
              );
            })
          )
        )
      ) : null
    );
  }

  // ─── Sessions Tab ──────────────────────────────────────────────────
  function SessionsTab(props) {
    var _s = useState(null), data = _s[0], setData = _s[1];
    var _e = useState(null), err = _e[0], setErr = _e[1];
    var _l = useState(false), loading = _l[0], setLoading = _l[1];
    var _p = useState(0), offset = _p[0], setOffset = _p[1];
    var _sort = useState("recent"), sort = _sort[0], setSort = _sort[1];
    var _src = useState(""), source = _src[0], setSource = _src[1];
    var _live = useState(false), liveOnly = _live[0], setLiveOnly = _live[1];
    var _exp = useState(null), expanded = _exp[0], setExpanded = _exp[1];
    var tr = useTimeRange("1M");
    var LIMIT = 30;

    var load = useCallback(function () {
      setLoading(true);
      setErr(null);
      var p = Object.assign({}, tr.params, { limit: LIMIT, offset: offset, sort: sort, source: source || undefined });
      if (liveOnly) p.active = "true";
      fetchJSON("/sessions", p)
        .then(function (d) { setData(d); setLoading(false); })
        .catch(function (e) { setErr(e.message); setLoading(false); });
    }, [offset, sort, source, liveOnly, tr.params, props.refreshKey]);

    useEffect(function () { load(); }, [load]);

    function toggleExpand(id) {
      setExpanded(expanded === id ? null : id);
    }

    if (err) return h("div", { className: "sa-error" }, "Error: " + err);
    if (!data) return h("div", { className: "sa-loading" }, "Loading...");

    var COL_COUNT = 9;

    return h("div", { className: "sa-sessions" },
      h(TimePicker, {
        selected: tr.rangeId,
        onChange: function (id) { tr.setRangeId(id); setOffset(0); },
        customSince: tr.customSince,
        customUntil: tr.customUntil,
        onCustomChange: function (s, u) { tr.onCustomChange(s, u); setOffset(0); },
      }),
      h("div", { className: "sa-toolbar" },
        h("div", { className: "sa-filter-row" },
          h("label", null, "Sort: "),
          h("select", {
            value: sort,
            onChange: function (e) { setSort(e.target.value); setOffset(0); },
            className: "sa-select",
          },
            h("option", { value: "recent" }, "Recent"),
            h("option", { value: "cost" }, "Cost"),
            h("option", { value: "tokens" }, "Tokens"),
            h("option", { value: "messages" }, "Messages"),
            h("option", { value: "duration" }, "Duration")
          ),
          h("label", null, " Source: "),
          h("select", {
            value: source,
            onChange: function (e) { setSource(e.target.value); setOffset(0); },
            className: "sa-select",
          },
            h("option", { value: "" }, "All"),
            h("option", { value: "slack" }, "Slack"),
            h("option", { value: "cron" }, "Cron"),
            h("option", { value: "webhook" }, "Webhook"),
            h("option", { value: "cli" }, "CLI")
          ),
          h("label", { className: "sa-live-toggle", onClick: function () { setLiveOnly(!liveOnly); setOffset(0); } },
            h("span", { className: "sa-live-checkbox" + (liveOnly ? " sa-live-checkbox-on" : "") },
              liveOnly ? "●" : ""
            ),
            " Live"
          )
        ),
        h("div", { className: "sa-pagination" },
          h(Button, { size: "sm", variant: "outline", disabled: offset === 0, onClick: function () { setOffset(Math.max(0, offset - LIMIT)); } }, "← Prev"),
          h("span", { className: "sa-page-info" }, (offset + 1) + "–" + Math.min(offset + LIMIT, data.total) + " of " + data.total),
          h(Button, { size: "sm", variant: "outline", disabled: offset + LIMIT >= data.total, onClick: function () { setOffset(offset + LIMIT); } }, "Next →")
        )
      ),

      loading ? h("div", { className: "sa-loading" }, "Loading...") :
      h("div", { className: "sa-table-wrap" },
        h("table", { className: "sa-table" },
          h("colgroup", null,
            h("col", { style: { width: "20px" } }),
            h("col", { style: { width: "30%" } }),
            h("col", { style: { width: "7%" } }),
            h("col", { style: { width: "18%" } }),
            h("col", { style: { width: "7%" } }),
            h("col", { style: { width: "7%" } }),
            h("col", { style: { width: "5%" } }),
            h("col", { style: { width: "5%" } }),
            h("col", { style: { width: "7%" } }),
            h("col", { style: { width: "12%" } })
          ),
          h("thead", null,
            h("tr", null,
              h("th", null, ""),
              h("th", null, "Title / ID"),
              h("th", null, "Source"),
              h("th", null, "Model"),
              h("th", { className: "sa-num" }, "Cost"),
              h("th", { className: "sa-num" }, "Tokens"),
              h("th", { className: "sa-num" }, "Msgs"),
              h("th", { className: "sa-num" }, "Tools"),
              h("th", { className: "sa-num" }, "Duration"),
              h("th", null, "Started")
            )
          ),
          h("tbody", null,
            (data.sessions || []).reduce(function (acc, s) {
              var isExp = expanded === s.id;
              acc.push(
                h("tr", {
                  key: s.id,
                  className: (s.is_active ? "sa-active-row " : "") + (isExp ? "sa-expanded-row " : "") + "sa-clickable-row",
                  onClick: function () { toggleExpand(s.id); },
                },
                  h("td", { className: "sa-expand-icon" }, isExp ? "▾" : "▸"),
                  h("td", { className: "sa-title-cell" },
                    h("div", { className: "sa-session-title" },
                      s.title || (s.source ? s.source + " session" : "(untitled)"),
                      s.is_active ? h("span", { className: "sa-live-badge" }, h("span", { className: "sa-live-dot" }), "LIVE") : null
                    ),
                    h("div", { className: "sa-session-id" },
                      s.id,
                      s.user_id ? " · " : "",
                      s.display_name && s.display_name !== s.user_id
                        ? h("span", null, h("span", { className: "sa-user-name-inline" }, s.display_name), " (" + s.user_id + ")")
                        : (s.user_id || "")
                    )
                  ),
                  h("td", null, h("span", { className: "sa-source-badge" }, s.source || "-")),
                  h("td", { className: "sa-model-cell" }, s.model || "-"),
                  h("td", { className: "sa-num" }, fmtCost(s.estimated_cost_usd)),
                  h("td", { className: "sa-num" }, fmtTokens(s.total_tokens)),
                  h("td", { className: "sa-num" }, s.message_count || 0),
                  h("td", { className: "sa-num" }, s.tool_call_count || 0),
                  h("td", { className: "sa-num" }, fmtDuration(s.duration_seconds)),
                  h("td", null, fmtDate(s.started_at))
                )
              );
              if (isExp) {
                acc.push(
                  h("tr", { key: s.id + "-detail", className: "sa-detail-row" },
                    h("td", { colSpan: COL_COUNT + 1, className: "sa-detail-cell" },
                      h(SessionDetail, { sessionId: s.id })
                    )
                  )
                );
              }
              return acc;
            }, [])
          )
        )
      )
    );
  }

  // ─── Costs Tab ─────────────────────────────────────────────────────
  function CostsTab(props) {
    var _s = useState(null), data = _s[0], setData = _s[1];
    var _e = useState(null), err = _e[0], setErr = _e[1];
    var _ts = useState(""), topSource = _ts[0], setTopSource = _ts[1];
    var tr = useTimeRange("1M");

    useEffect(function () {
      setData(null);
      var p = Object.assign({}, tr.params);
      if (topSource) p.top_source = topSource;
      fetchJSON("/costs", p)
        .then(setData)
        .catch(function (e) { setErr(e.message); });
    }, [tr.params, topSource, props.refreshKey]);

    if (err) return h("div", { className: "sa-error" }, "Error: " + err);
    if (!data) return h("div", { className: "sa-loading" }, "Loading...");

    var SOURCE_TABS = [
      { id: "", label: "All" },
      { id: "slack", label: "Slack" },
      { id: "cron", label: "Cron" },
      { id: "webhook", label: "Webhook" },
    ];

    return h("div", { className: "sa-costs" },
      h("div", { className: "sa-header" },
        h("h2", null, "Cost Analytics"),
        h(TimePicker, {
          selected: tr.rangeId,
          onChange: tr.setRangeId,
          customSince: tr.customSince,
          customUntil: tr.customUntil,
          onCustomChange: tr.onCustomChange,
        })
      ),

      h(Card, { className: "sa-chart-card sa-full" },
        h(CardContent, null,
          h("h3", null, "Daily Cost Trend"),
          h(Sparkline, { data: data.daily, valueKey: "cost", formatValue: fmtCost })
        )
      ),

      h("div", { className: "sa-charts-row" },
        h(Card, { className: "sa-chart-card" },
          h(CardContent, null,
            h("h3", null, "Cost by Model"),
            h(BarChart, { data: data.by_model, labelKey: "model", valueKey: "total_cost", formatValue: fmtCost })
          )
        ),
        h(Card, { className: "sa-chart-card" },
          h(CardContent, null,
            h("h3", null, "Cost by Caller"),
            h(BarChart, { data: data.by_user.slice(0, 15), labelKey: "display_name", valueKey: "total_cost", formatValue: fmtCost })
          )
        )
      ),

      (data.by_platform && data.by_platform.length > 0) ?
        h(Card, { className: "sa-chart-card sa-full" },
          h(CardContent, null,
            h("h3", null, "Cost by Platform (Webhooks & Crons)"),
            h(BarChart, { data: data.by_platform.slice(0, 20), labelKey: "platform_id", valueKey: "total_cost", formatValue: fmtCost })
          )
        ) : null,

      h(Card, { className: "sa-chart-card sa-full" },
        h(CardContent, null,
          h("div", { className: "sa-top-sessions-header" },
            h("h3", null, "Top Expensive Sessions"),
            h("div", { className: "sa-source-tabs" },
              SOURCE_TABS.map(function (st) {
                return h("span", {
                  key: st.id,
                  className: "sa-source-tab" + (topSource === st.id ? " sa-source-tab-active" : ""),
                  onClick: function () { setTopSource(st.id); },
                }, st.label);
              })
            )
          ),
          h("table", { className: "sa-table sa-compact" },
            h("thead", null,
              h("tr", null,
                h("th", null, "Title / ID"),
                h("th", null, "Model"),
                h("th", { className: "sa-num" }, "Cost"),
                h("th", { className: "sa-num" }, "Tokens"),
                h("th", null, "Source")
              )
            ),
            h("tbody", null,
              (data.top_sessions || []).map(function (s) {
                return h("tr", { key: s.id },
                  h("td", { className: "sa-title-cell" },
                    h("div", { className: "sa-session-title" }, s.title || (s.source ? s.source + " session" : "(untitled)")),
                    h("div", { className: "sa-session-id" }, s.id)
                  ),
                  h("td", { className: "sa-model-cell" }, s.model || "-"),
                  h("td", { className: "sa-num sa-cost-highlight" }, fmtCost(s.estimated_cost_usd)),
                  h("td", { className: "sa-num" }, fmtTokens((s.input_tokens || 0) + (s.output_tokens || 0))),
                  h("td", null, h("span", { className: "sa-source-badge" }, s.source || "-"))
                );
              })
            )
          )
        )
      )
    );
  }

  // ─── Tools Tab ─────────────────────────────────────────────────────
  function ToolsTab(props) {
    var _s = useState(null), data = _s[0], setData = _s[1];
    var _e = useState(null), err = _e[0], setErr = _e[1];
    var tr = useTimeRange("1M");

    useEffect(function () {
      setData(null);
      fetchJSON("/tools", tr.params)
        .then(setData)
        .catch(function (e) { setErr(e.message); });
    }, [tr.params, props.refreshKey]);

    if (err) return h("div", { className: "sa-error" }, "Error: " + err);
    if (!data) return h("div", { className: "sa-loading" }, "Loading...");

    return h("div", { className: "sa-tools" },
      h("div", { className: "sa-header" },
        h("h2", null, "Tool Usage"),
        h(TimePicker, {
          selected: tr.rangeId,
          onChange: tr.setRangeId,
          customSince: tr.customSince,
          customUntil: tr.customUntil,
          onCustomChange: tr.onCustomChange,
        })
      ),
      h(Card, { className: "sa-chart-card sa-full" },
        h(CardContent, null,
          h("h3", null, "Tool Call Frequency (" + data.total_distinct_tools + " tools)"),
          h(BarChart, {
            data: data.tools.slice(0, 30),
            labelKey: "name",
            valueKey: "call_count",
            formatValue: function (v) { return v.toLocaleString(); },
          })
        )
      )
    );
  }

  // ─── User Table (reusable) ──────────────────────────────────────────
  function UserTableSection(props) {
    var title = props.title;
    var users = props.users;
    var colHeader = props.colHeader || "User";

    if (!users || users.length === 0) return null;

    return h(Card, { className: "sa-chart-card sa-full" },
      h(CardContent, null,
        h("h3", null, title + " (" + users.length + ")"),
        h("div", { className: "sa-table-wrap" },
          h("table", { className: "sa-table sa-compact" },
            h("thead", null,
              h("tr", null,
                h("th", null, colHeader),
                h("th", { className: "sa-num" }, "Sessions"),
                h("th", { className: "sa-num" }, "Cost"),
                h("th", { className: "sa-num" }, "Tokens"),
                h("th", { className: "sa-num" }, "Messages"),
                h("th", { className: "sa-num" }, "Tool Calls"),
                h("th", null, "Last Active")
              )
            ),
            h("tbody", null,
              users.map(function (u) {
                return h("tr", { key: u.user_id },
                  h("td", null,
                    h("div", { className: "sa-user-name" }, u.display_name || u.user_id),
                    u.display_name && u.display_name !== u.user_id
                      ? h("div", { className: "sa-user-id" }, u.user_id)
                      : null
                  ),
                  h("td", { className: "sa-num" }, u.session_count),
                  h("td", { className: "sa-num" }, fmtCost(u.total_cost)),
                  h("td", { className: "sa-num" }, fmtTokens(u.total_tokens)),
                  h("td", { className: "sa-num" }, u.total_messages),
                  h("td", { className: "sa-num" }, u.total_tool_calls),
                  h("td", null, fmtDate(u.last_active))
                );
              })
            )
          )
        )
      )
    );
  }

  // ─── Users Tab ─────────────────────────────────────────────────────
  function UsersTab(props) {
    var _s = useState(null), data = _s[0], setData = _s[1];
    var _e = useState(null), err = _e[0], setErr = _e[1];
    var tr = useTimeRange("1M");

    useEffect(function () {
      setData(null);
      fetchJSON("/users", tr.params)
        .then(setData)
        .catch(function (e) { setErr(e.message); });
    }, [tr.params, props.refreshKey]);

    if (err) return h("div", { className: "sa-error" }, "Error: " + err);
    if (!data) return h("div", { className: "sa-loading" }, "Loading...");

    var allUsers = data.users || [];
    var humans = allUsers.filter(function (u) { return u.user_type === "human"; });
    var automations = allUsers.filter(function (u) { return u.user_type === "automation"; });
    var crons = allUsers.filter(function (u) { return u.user_type === "cron"; });
    var system = allUsers.filter(function (u) { return u.user_type === "system"; });

    return h("div", { className: "sa-users" },
      h("div", { className: "sa-header" },
        h("h2", null, "User Analytics"),
        h(TimePicker, {
          selected: tr.rangeId,
          onChange: tr.setRangeId,
          customSince: tr.customSince,
          customUntil: tr.customUntil,
          onCustomChange: tr.onCustomChange,
        })
      ),

      h(UserTableSection, { title: "Users", users: humans, colHeader: "User" }),
      h(UserTableSection, { title: "Automations (Webhooks)", users: automations, colHeader: "Webhook" }),
      h(UserTableSection, { title: "Cron Jobs", users: crons, colHeader: "Cron Job" }),
      h(UserTableSection, { title: "System / Other", users: system, colHeader: "Caller" }),

      allUsers.length === 0 ? h("div", { className: "sa-loading" }, "No user data for this period") : null
    );
  }

  // ─── Main Plugin Component ─────────────────────────────────────────
  function SessionAnalytics() {
    var _t = useState("overview"), tab = _t[0], setTab = _t[1];
    var _rk = useState(0), refreshKey = _rk[0], setRefreshKey = _rk[1];

    var tabs = [
      { id: "overview", label: "Overview" },
      { id: "sessions", label: "Sessions" },
      { id: "costs", label: "Costs" },
      { id: "tools", label: "Tools" },
      { id: "users", label: "Users" },
    ];

    var doRefresh = useCallback(function () {
      setRefreshKey(function (k) { return k + 1; });
    }, []);

    return h("div", { className: "sa-root" },
      h("div", { className: "sa-tabs" },
        tabs.map(function (t) {
          return h(Button, {
            key: t.id,
            variant: tab === t.id ? "default" : "ghost",
            size: "sm",
            onClick: function () { setTab(t.id); },
            className: "sa-tab-btn",
          }, t.label);
        }),
        h(Button, {
          variant: "outline",
          size: "sm",
          onClick: doRefresh,
          className: "sa-refresh-btn",
          title: "Refresh data",
        }, "↻ Refresh")
      ),
      h("div", { className: "sa-content" },
        tab === "overview" ? h(OverviewTab, { refreshKey: refreshKey }) : null,
        tab === "sessions" ? h(SessionsTab, { refreshKey: refreshKey }) : null,
        tab === "costs" ? h(CostsTab, { refreshKey: refreshKey }) : null,
        tab === "tools" ? h(ToolsTab, { refreshKey: refreshKey }) : null,
        tab === "users" ? h(UsersTab, { refreshKey: refreshKey }) : null
      )
    );
  }

  window.__HERMES_PLUGINS__.register("session-analytics", SessionAnalytics);
})();
