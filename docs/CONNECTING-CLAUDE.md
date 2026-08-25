# Letting Claude answer questions about this

There is an MCP server built in. Once someone adds it to their Claude config,
they can ask things like:

- *"What trade show audiences do we have for Dynamic Friction?"*
- *"How big is the SEMA contact list, and has it grown?"*
- *"What did we load for AAPEX, and what did it produce?"*
- *"Which of our audiences are too small to run on Meta?"*
- *"Where is the Trade Show Universe audience being used?"*

It is **read-only**. Every tool reads files; none of them write to HubSpot or
to the registry. Asking a question can never change anything, which is a
property worth having when several people can ask.

---

## Adding it — Claude Code

```bash
claude mcp add tradeshow-funnel -- node "C:/Users/benwe/Claude Code/Code - Paid Search+Social/tradeshow-funnel/bin/tsf.js" mcp
```

Change the path to wherever the repo is on that machine.

## Adding it — Claude Desktop

Edit `claude_desktop_config.json`:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tradeshow-funnel": {
      "command": "node",
      "args": [
        "C:/Users/benwe/Claude Code/Code - Paid Search+Social/tradeshow-funnel/bin/tsf.js",
        "mcp"
      ]
    }
  }
}
```

Restart Claude Desktop. The tools appear under the connectors icon.

---

## What each person needs

The MCP server runs on **their** machine, reading **their** copy of the repo.
So each person needs:

1. Node installed
2. The repo cloned, and `npm install` run once
3. The config entry above
4. To `git pull` when they want current numbers

That last point is the honest catch: **they see the registry as of their last
pull.** Whoever does the uploading should commit and push after each show, and
everyone else pulls before they ask. For a program that moves a handful of times
a year that is fine; if it starts to grate, the fix is hosting the tool, and
Google sign-in is already built for that day.

**No HubSpot credentials are needed** to run the MCP server — it only reads the
files in `data/`. Only the person doing the uploading needs a token.

---

## The lower-effort option

If someone just wants to look rather than ask, `AUDIENCES.md` renders on GitHub.
Open the repo in a browser and it is all there — sizes, history, shows,
destinations. No install, no config, nothing to keep current beyond the person
uploading remembering to push.

Worth pointing people at that first. The MCP server is for the ones who want to
ask questions rather than read a table.

---

## The tools it exposes

| Tool | What it answers |
| --- | --- |
| `program_summary` | The whole program at a glance, per brand. Good opener. |
| `list_audiences` | Every audience: brand, type, size, where used, readiness. |
| `get_audience` | One audience in full, including its size history over time. |
| `list_shows` | Every show, with what has been loaded for it. |
| `get_show` | One show: dates, venue, lists loaded, audiences built. |
| `search_history` | The append-only log. "What happened in March." |

Each returns readable prose rather than raw JSON, so the answers come back in
plain language and a person reading the raw output can follow it too.

---

## Things it will tell people, and should

The tools carry their own caveats, so the answers stay honest:

- Sizes are **as of the last refresh**, not live.
- **Never sum across brands.** R1 and DFC are deliberately separate.
- **Never sum two audiences.** They overlap — the same person attends more than
  one show.
- A **geo audience has no size**. "How big is it" does not apply to one.
