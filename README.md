# @pipeworx/mo-dmv

Missouri DMV data: the Department of Revenue's driver and motor-vehicle **license offices**,
with hours, the contract agent who runs each one, and the upcoming dates it will be closed.
Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## What Missouri calls its DMV

Missouri has no "DMV". Driver licensing and vehicle registration happen at **license offices**
run by the **Missouri Department of Revenue**, and — unusually — the state does not staff them
itself. All 176 offices are contracted out to private agents, which is why `agent`,
`officemanager` and `contractmanager` are real columns here and have no analogue in another
state's office file. Hours, phone numbers and closures follow the agent, not the state.

## Tools

| Tool | What it returns |
|---|---|
| `mo_dmv_license_offices` | Address, phone, days and hours open, coordinates, contract agent, office manager, and upcoming closure dates for all 176 offices |

Filters: `city`, `name`, `zip`, `limit`.

## Auth

None. `data.mo.gov` is a public Socrata portal and the public rate limit is ample without an
app token.

## Why this is the freshest DMV endpoint in any state

Missouri **refreshes this dataset daily** — `as_of` came back as the current date on every
verification call. That is what makes `additional_days_closed` worth returning: the closure
list is current enough to plan a visit around, which no other state's office file supports.

Entries can be whole days (`11/27/2026`) or partial (`6/22/2026 Closed Partial Day PM`), and
they sit *ahead of* the separately published `holidays_closed` list rather than duplicating it.

## Gotchas worth knowing

These are live-verified behaviours, not guesses:

- **`county` is empty on all 176 rows.** The column exists upstream and is null everywhere, so
  the tool passes it through as `null` rather than inventing one. Filter by `city` instead.
- **`type` is `1MV` on every office.** Every Missouri license office does both driver licensing
  and motor vehicle work, so the code carries no discriminating information today; it is
  surfaced in `office_type` in case the state ever splits the categories.
- **Some ZIPs are stored as ZIP+4 with no hyphen** (`658075187`). The `zip` filter is a
  prefix match, so a five-digit ZIP still matches those rows.
- **`url` is a Facebook page when it exists.** Many contract agents run a Facebook page instead
  of a website, and that is the only per-office link the state publishes.
- **`as_of` is fetched concurrently with the data**, not after it. Socrata throttles
  unauthenticated bursts and the metadata helper does not retry, so a sequential call
  intermittently lost the refresh date — on a file whose whole value is a daily refresh.

## Data sources

- [data.mo.gov](https://data.mo.gov) Socrata `835g-7keg` — Missouri Department of Revenue
  Driver and Motor Vehicle License Offices

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "mo-dmv": {
      "url": "https://gateway.pipeworx.io/mo-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/mo-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/mo_dmv_license_offices \
  -H 'Content-Type: application/json' \
  -d '{"city":"Columbia"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/mo_dmv_license_offices`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "mo-dmv": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-mo-dmv"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-mo-dmv
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Mo Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
