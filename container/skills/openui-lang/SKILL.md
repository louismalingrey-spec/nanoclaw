---
name: openui-lang
description: |
  Generative UI for the NanoClaw OS workspace — render live React dashboards, charts, tables, and forms inline in chat replies or as persistent apps in the sidebar. Trigger when the user is in the workspace UI (web channel) AND wants a *visual* answer: chart, table, comparison, KPI, dashboard, "show me", or a multi-preference form. Skip on Telegram/Slack/iMessage (those channels don't render OpenUI — reply with plain text). Skip for casual chat and one-line factual answers.
---

# OpenUI Lang — visual answers in NanoClaw OS

The NanoClaw OS workspace UI renders OpenUI Lang code as live React components (charts, tables, forms, dashboards). Use it when seeing the answer beats reading it.

## When to use it

Trigger words / situations:
- chart, graph, plot, trend, comparison, breakdown, summary, table, KPI, metric, dashboard, status board — the user wants to *see*.
- multi-preference questions ("which X should I pick", "help me choose") → render a `Form` instead of asking N questions in a row.
- structured rundown (3+ logical sections) → use `SectionBlock` / `SectionItem` accordion.
- end of a substantive answer → close with `FollowUpBlock` suggesting next prompts.

When NOT to use it:
- casual chat ("thanks", "hi"), single-sentence factual answers.
- conversations on Telegram / Slack / iMessage / email — those channels can't render OpenUI. Fall back to plain text.

## Two surfaces

**Inline UI** — embedded in your chat reply. Static (no live data, no refresh). Just include OpenUI Lang code in your assistant message and the workspace renders it inside the bubble. Best for one-off visual answers.

**Persistent app** — call `app_create({ name, code })`. Saved in the sidebar; user can re-open it any time. Use for dashboards / status boards / anything they'd want to revisit. Combine with `db_execute` + `Query("sql", ...)` for live data.

## The DSL — assignment-based, NOT nested

Programs are a series of `name = Component(args)` statements. `root = ...` is mandatory and is the rendered tree.

✅ Correct:
```
root = Card([title, table])
title = TextContent("État du système", "large-heavy")
table = Table([metric, value])
metric = Col("Métrique", ["Sessions actives", "Messages aujourd'hui"])
value = Col("Valeur", ["12", "348"])
```

❌ Wrong (nested calls — your training data may suggest this; the parser rejects it):
```
root = Card([TextContent("État", "large-heavy"), Table([Col("Métrique", [...])])])
```

## Catalog (NanoClaw OS chat surface)

Containers and layout:
- `Card(children)` — vertical container, the default chat wrapper. **Always wrap your output in a `Card`** unless rendering a single text line.
- `CardHeader(title, subtitle?)` — heavy title row.
- `Separator()` — horizontal rule.
- `SectionBlock(sections)` + `SectionItem(value, trigger, content)` — collapsible accordion.

Text:
- `TextContent(text, size?)` — `size` ∈ `"small"` | `"default"` | `"large"` | `"small-heavy"` | `"large-heavy"`.
- `MarkDownRenderer(md)` — full markdown block. **Never put triple-backticks inside the string.**
- `Callout(text, variant?)`, `TextCallout(...)`, `Hint(...)`.

Tables — column-major:
- `Table(columns)` where each column is `Col(label, data, type?)`.

Charts:
- `BarChart(labels, series)`, `LineChart(labels, series)`, `AreaChart(labels, series)`, `HorizontalBarChart(labels, series)` — `series = [Series(name, dataArray), ...]`.
- `PieChart(slices)` with `Slice(label, value)`.
- `ScatterChart(datasets)` with `ScatterSeries(...)` and `Point(...)`.

Forms:
- `Form(name, buttons, fields)` with `FormControl(label, child)`, `Input(name, placeholder?)`, `TextArea(...)`, `Select(name, items)`, `SelectItem(value, label)`, `DatePicker(name)`, `Slider(name, min, max)`, `CheckBoxGroup/RadioGroup/SwitchGroup(name, items)`.
- Buttons: `Button(label, action)` where `action` is a string the workspace echoes back as the user's next message.

Lists & follow-ups:
- `ListBlock(items)` + `ListItem(title, description?)` — clickable list.
- `FollowUpBlock(items)` + `FollowUpItem(text)` — suggested next prompts. **End substantive answers with one of these** when there are obvious next steps.
- `Buttons([Button(label, action), ...])` — group of inline action buttons.

Misc:
- `Tag(label, variant?, size?)`, `TagBlock([Tag(...)])`.
- `Image(src, alt?)`, `ImageBlock(src, alt?)`, `ImageGallery(items)`.
- `CodeBlock(code, language?)`, `Carousel(items, variant?)`.
- `Tabs(tabs)` + `TabItem(value, label, content)`.
- `Steps(items)` + `StepsItem(title, description?, status?)`.

## Things that DON'T exist

`Stack`, `Grid`, `Heading`, `KpiCard`, `Metric`, `Markdown`, `Badge`, `Divider`, `Section`, `Tab` (use `TabItem`). `@Map`, `@FormatDate`, `@FormatNumber`, `@Length`, `@Find` builtins. Nested function call syntax — always use named statements.

## Live data in apps

Persistent apps read fresh data on every open + on a refresh interval via `Query()`. Two-sided:

1. **You** prep the data once with `db_execute({ sql })` against the per-agent-group sandbox SQLite. Use to create tables + seed rows. **One statement per call.**
2. **The app** reads with `Query("sql", { q: "SELECT ..." }, defaults, refreshSeconds)`. The workspace runs the SELECT against the same sandbox on a `refreshSeconds` cadence (omit for one-shot).

Pattern — counter dashboard refreshing every minute:
```ts
// Step 1: schema + seed (call once, from chat or after a long task):
db_execute({ sql: "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts TEXT, kind TEXT)" })
db_execute({ sql: "INSERT INTO events (ts, kind) VALUES (datetime('now'), 'message')" })

// Step 2: create the app:
app_create({ name: "Activity today", code: `
  metrics = Query("sql", { q: "SELECT count(*) AS messages FROM events WHERE date(ts) = date('now')" }, [{ messages: 0 }], 60)
  header = TextContent("Today's activity", "large-heavy")
  big = TextContent(metrics[0].messages, "large-heavy")
  root = Card([header, big])
` })
```

Rules:
- `Query()` second arg must contain `q` (string). Optional `params` for `?` / `$name` placeholders — NEVER inline user-controlled values into `q`.
- Third arg is the default value before first fetch resolves.
- Fourth arg is refresh interval in seconds. Omit (or 0) for one-shot.
- Read-only — only SELECT/WITH/PRAGMA/EXPLAIN over the UI path. For writes use `db_execute` from the chat side.
- Sandbox is per-agent-group, no cross-group access.

## Bottom line

Don't *explain* that you can render UI. Just do it when it makes the answer easier to read. If you can't tell whether the channel supports it, the agent name in your system prompt usually has hints; otherwise ask once and remember in `CLAUDE.local.md`.
