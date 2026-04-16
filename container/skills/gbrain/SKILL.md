---
name: gbrain
description: |
  Brain-first knowledge ops. Always check the brain before answering questions
  about people, companies, or concepts. Write new knowledge back after every
  conversation where something notable is learned.
---

# GBrain — Brain-First Knowledge

You have access to a personal knowledge brain via `mcp__gbrain__*` tools.
The brain lives at `~/brain` and is indexed for fast search.

## Brain structure

```
people/creators/    — creators you work with or could work with
people/clients/     — client contacts
people/prospects/   — sales prospects
companies/          — companies, apps, products
concepts/formats/   — content formats (listicles, case studies, etc.)
concepts/hooks/     — hook patterns and frameworks
concepts/strategies/— growth and distribution strategies
deals/              — proposals and deals
meetings/           — meeting notes
inbox/              — unclassified captures
```

## Rule 1: Brain-first on every message

Before answering any question about a person, company, format, or concept:

1. `mcp__gbrain__search` — keyword search (names, exact terms)
2. `mcp__gbrain__query` — hybrid search (conceptual questions)
3. `mcp__gbrain__get_page` — read full page if search confirms it exists

Never answer from general knowledge when the brain has relevant pages.

## Rule 2: Write back after conversations

When a conversation reveals new notable information — do this SILENTLY after responding (never announce it):

- **New person mentioned** → `mcp__gbrain__put_page` with slug `people/{type}/{slug}`
- **New company mentioned** → `mcp__gbrain__put_page` with slug `companies/{slug}`  
- **New format/concept/strategy** → `mcp__gbrain__put_page` with slug `concepts/{type}/{slug}`
- **Existing entity updated** → `mcp__gbrain__add_timeline_entry` on their page

Notability gate: only capture if the entity appears more than once OR the user shares a specific fact about them.

## Rule 3: Signal detection (silent, non-blocking)

On every user message, check for:

1. **Original thinking**: novel ideas, frameworks, theses the user expresses → capture to `originals/{slug}` with EXACT phrasing
2. **Entity mentions**: people or companies referenced → check brain, enrich if missing
3. **Facts about known entities** → add timeline entry

Never interrupt your response for this. Do it after responding.

## Page format

All pages must have YAML frontmatter:

```markdown
---
type: person          # person | company | concept | deal | meeting | original | idea
title: Full Name
---

## Compiled Truth

Current synthesis of everything known. [Source: User, 2026-04-15]

## Timeline

- **2026-04-15** | First mentioned in conversation [Source: Conversation]
```

## Tool reference

| Tool | When to use |
|------|-------------|
| `mcp__gbrain__search` | Look up by name, exact term, or slug fragment |
| `mcp__gbrain__query` | Conceptual questions, topic exploration |
| `mcp__gbrain__get_page` | Read a full page after search confirms it exists |
| `mcp__gbrain__put_page` | Create or update a brain page |
| `mcp__gbrain__list_pages` | Browse pages by type |
| `mcp__gbrain__add_timeline_entry` | Append a dated fact to an entity page |
| `mcp__gbrain__get_backlinks` | Find pages that reference a given entity |
| `mcp__gbrain__get_stats` | Check brain health and page counts |

## Brain-first lookup protocol (5 steps)

1. `search("name")` — does a page exist?
2. `query("natural question about name")` — any related context?
3. `get_page(slug)` — read the full page if found
4. `get_backlinks(slug)` — who else references this entity?
5. Answer using brain content + cite: "[Source: people/jane-doe, compiled truth]"

If the brain has nothing: answer from general knowledge, flag the gap.

## Anti-patterns

- Answering questions about people/companies without checking the brain
- Writing brain pages without YAML frontmatter
- Creating pages for non-notable one-time mentions
- Announcing "I'm updating the brain" — just do it silently
- Paraphrasing original thinking instead of capturing exact phrasing
