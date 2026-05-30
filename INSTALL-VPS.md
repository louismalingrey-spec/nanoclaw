# VPS install — agency-os bridge

Single-tenant note for the **agency-os** project: this fork
(`louismalingrey-spec/nanoclaw`) tracks two divergent histories on
purpose, and the Hetzner VPS installer (`agency-os` repo →
`deploy/hetzner-stack/nanoclaw/install-nanoclaw.sh`) must clone the
**`stable-vps`** branch, not the default `main`.

## Branch layout

| Branch       | Tracks                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `main`       | Upstream NanoClaw OS catch-up + skills (Gmail, Slack, GBrain integration skill, prospection). Diverged from upstream. |
| `stable-vps` | VPS deploy track: container `Dockerfile`, gbrain MCP stdio bridge, OneCLI/OpenRouter routing, `http-api/dispatcher`.  |

The two branches share an ancestor (`934f063`) but are NOT fast-forward
mergeable in either direction — they evolve independently. `stable-vps`
is the install target because it carries the bridge files that
agency-os calls into (`src/gbrain-proxy.ts`,
`container/agent-runner/src/gbrain-mcp-stdio.ts`, `container/Dockerfile`).

## How to install on the VPS

```bash
# On the VPS, inside the agency-os checkout:
cd /opt/agency-os-stack/agency-os/deploy/hetzner-stack/nanoclaw
sudo ./install-nanoclaw.sh \
  --nanoclaw-repo https://github.com/louismalingrey-spec/nanoclaw.git
```

⚠ The current `install-nanoclaw.sh` clones the **default branch**
(`main`), which lacks the bridge. Until that script is updated to
accept `--branch stable-vps` (or until `main` is rebuilt to include
both tracks), the operator must manually checkout `stable-vps` after
the clone:

```bash
cd /opt/agency-os-stack/nanoclaw-v2
git checkout stable-vps
git pull --ff-only fork stable-vps
# then re-run install-nanoclaw.sh to finish the build + compose-up
```

## How to keep `stable-vps` updated

All agency-os-critical patches land on `stable-vps` directly via PR on
this fork (`louismalingrey-spec/nanoclaw`). See PRs #1–#15 (2026-05-28
to 2026-05-29) for the historical lineage that built the current
bridge. Skill-side merges from upstream NanoClaw land on `main` and
should not be cherry-picked into `stable-vps` unless they're
agency-os-relevant.

## Pollution dirs gitignored 2026-05-30

The fork tree historically accumulated three sibling dirs during Mac
dev (`.claude/worktrees/`, `leads-dashboard/`, `my-automations/`) that
were never meant to be tracked. They are now in `.gitignore` so they
stop showing in `git status` after every session.
