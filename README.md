# @pipeworx/mo-dmv

Missouri DMV data: the Department of Revenue's driver and motor-vehicle **license offices**,
with hours, the contract agent who runs each one, and the upcoming dates it will be closed.
Keyless.

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

Or connect to the full Pipeworx gateway for access to all 1392+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Missouri License Offices data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
