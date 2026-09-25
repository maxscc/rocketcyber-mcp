# Kaseya MDR MCP — Suffolk deployment

Kaseya renamed RocketCyber to **Kaseya MDR**. The service, install folder, hostname and portal entry all use the new name. The API (`api-us.rocketcyber.com`), the `ROCKETCYBER_*` settings and the `rocketcyber_*` tool names keep the old name, because that's what the vendor API and the upstream project still use. Keeping them the same also keeps upstream merges simple.

Suffolk's fork (GitHub repo `maxscc/rocketcyber-mcp`) of [WYRE-AI/rocketcyber-mcp](https://github.com/WYRE-AI/rocketcyber-mcp), branch `suffolk` (based on upstream `2062630`, v1.1.7). It sits behind the Cloudflare **SCC MCP** portal next to the UniFi, UISP, Avanan, ConnectWise PSA, Datto RMM, Datto EDR and SaaS Alerts MCP servers, and is set up the same way.

## What the fork changes

(Plus: the server now reports itself to MCP clients as `kaseya-mdr-mcp`, set by `MCP_SERVER_NAME`, and its instructions say Kaseya MDR.)

| Change | Why |
|---|---|
| `MCP_BEARER_TOKEN` is required on `/mcp` whenever it's set (`src/mcp/server.ts`, `src/utils/bearer.ts`) | Upstream has no auth on `/mcp` outside its own gateway. Now it works like the other SCC servers. `/health` stays open. |
| `@wyre-technology/node-rocketcyber` is vendored (`vendor/wyre-technology-node-rocketcyber-1.1.3.tgz`), `.npmrc` removed | Upstream only publishes it to GitHub Packages, which needs a token even for public packages. The tarball is built from the public [WYRE-AI/node-rocketcyber](https://github.com/WYRE-AI/node-rocketcyber) source (v1.1.3, no runtime dependencies), so `npm ci` only uses public npm. |
| `clean` script uses Node instead of `rm -rf` | `npm run build` runs `prebuild` → `clean`, and `rm` doesn't exist in cmd.exe on Windows. |
| `install-service.ps1`, `.env.suffolk.example` | Same installer flow as the other servers (WinSW service, locked-down `.env`, connection check). |
| Tool fixes (`src/handlers/suffolk.ts`) | `list_incidents` / `list_events` default to newest first (`createdAt:desc`; events fall back to `detectedAt:desc`, then to the API's own order if the API rejects sorting). `list_apps` no longer sends `page`/`pageSize`, which `/apps` rejects with 400. `get_office` returns a per-customer summary (mailbox + MFA counts) by default. `summary: false` lists mailboxes, filtered by `accountId` / `mfa` / `search`, paged with `limit`/`offset` and capped at ~40K characters. `raw: true` returns the untouched response. |
| `src/__tests__/suffolk.test.ts` | Covers the bearer check over real HTTP, and fails if upstream adds a tool that isn't a `test`/`get`/`list` read. `src/__tests__/suffolk-tools.test.ts` covers the tool fixes. All 36 upstream tests still pass (53 total). |

No read-only gate is needed: all 10 upstream tools are reads, and the RocketCyber v3 API this uses has no write endpoints.

## Setup (Windows Server)

1. **Create the API key.** In the Kaseya MDR (RocketCyber) console, go to **Provider Settings → API** and copy the key. It's sent as `Authorization: Bearer <key>` to `https://api-us.rocketcyber.com/v3` (set `ROCKETCYBER_REGION=eu` only if the account is on the EU instance).
2. **Node.js LTS for all users** should already be installed from the other servers. If it isn't, run `winget install OpenJS.NodeJS.LTS` and open a new PowerShell.
3. **Get the code** into `C:\Services\kaseya-mdr-mcp`:
   ```powershell
   git clone https://github.com/maxscc/rocketcyber-mcp.git C:\Services\kaseya-mdr-mcp
   cd C:\Services\kaseya-mdr-mcp
   git checkout -b suffolk
   git am "<path>\0001-suffolk-kaseya-mdr-mcp.patch"
   git push -u origin suffolk      # optional, keeps the fork in sync
   ```
   After the branch is pushed, later installs can use `git clone -b suffolk ...` instead.
4. **Run the installer** from an elevated PowerShell:
   ```powershell
   cd C:\Services\kaseya-mdr-mcp
   Set-ExecutionPolicy -Scope Process Bypass
   .\install-service.ps1
   ```
   - **First run:** it builds the server and creates `.env` with a random `MCP_BEARER_TOKEN`. It then opens `.env` in Notepad so you can fill in `ROCKETCYBER_API_KEY`.
   - **Second run:** it tests Kaseya MDR (`rocketcyber_get_account` on a temporary local port), then installs the **SCC-KaseyaMDRClaudeMCP** service on port **8772** (Automatic, delayed start, LocalSystem, restarts on failure). It confirms the endpoint rejects requests without the token.
5. **Firewall:** if cloudflared runs on another machine, let it reach TCP 8772: `.\install-service.ps1 -OpenFirewall -RemoteAddress <cloudflared-IP>`.

### Day-to-day

```powershell
Restart-Service SCC-KaseyaMDRClaudeMCP                                                      # after editing .env
Get-Content C:\Services\kaseya-mdr-mcp\logs\SCC-KaseyaMDRClaudeMCP.err.log -Tail 50 -Wait   # server log (stderr)
.\install-service.ps1 -Uninstall
```

## Cloudflare (same tunnel and portal as the others)

1. **Tunnel → Public Hostname:** `kaseya-mdr-mcp.suffolkit.com` → HTTP → `192.168.97.8:8772`. Use `localhost:8772` if cloudflared runs on this server.
2. **Access:** protect the hostname the same way as `cwpsa-mcp.suffolkit.com`, with the **SCC-ServiceTokens** service-token policy.
3. **Test it**, going through Cloudflare DNS so internal DNS doesn't interfere. `401` means everything works:
   ```powershell
   curl.exe -s -o NUL -w "%{http_code}`n" --doh-url https://1.1.1.1/dns-query -X POST https://kaseya-mdr-mcp.suffolkit.com/mcp -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>"
   ```
4. **MCP Portals → MCP servers → Add:**
   - Name `Kaseya MDR`, server ID `kaseya-mdr-mcp`, URL `https://kaseya-mdr-mcp.suffolkit.com/mcp`
   - Custom headers: `Authorization: Bearer <MCP_BEARER_TOKEN>`, plus `CF-Access-Client-Id` and `CF-Access-Client-Secret`
   - Policies: **SCC-ServiceTokens** and **SCC-MCP-StaffAllow**
5. **Server portals → SCC MCP → Select existing servers:** add `kaseya-mdr-mcp` with **User auth required** off.

Claude picks up the new tools through the existing connector. Reconnect it if they don't appear.

## Tools (all read-only)

| Area | Tools |
|---|---|
| Account | `rocketcyber_get_account`, `rocketcyber_test_connection` |
| Agents | `rocketcyber_list_agents` |
| Incidents | `rocketcyber_list_incidents` (newest first; long text truncated unless `verbose: true`) |
| Events | `rocketcyber_get_event_summary`, `rocketcyber_list_events` (newest first; needs `appId` — get it from the summary or `list_apps`) |
| Firewalls / Apps | `rocketcyber_list_firewalls`, `rocketcyber_list_apps` |
| Defender / Office 365 | `rocketcyber_get_defender`, `rocketcyber_get_office` (summary by default; `summary: false` + `accountId`/`mfa`/`search` to list mailboxes) |

Also exposes 3 MCP resources: `rocketcyber://account`, `rocketcyber://incidents`, `rocketcyber://agents`.

## Updating from upstream

```powershell
cd C:\Services\kaseya-mdr-mcp
git remote add upstream https://github.com/WYRE-AI/rocketcyber-mcp.git   # first time only
git fetch upstream --tags
git merge upstream/main      # resolve conflicts in src/mcp/server.ts / package.json / package-lock.json if any
npm test                     # suffolk.test.ts fails if a new non-read tool shows up
git push
.\install-service.ps1         # stops the service, rebuilds, reinstalls
```

- If upstream bumps `@wyre-technology/node-rocketcyber` (or moves to `@wyre-ai/node-rocketcyber`), rebuild the vendored tarball from the matching version of WYRE-AI/node-rocketcyber (`npm ci --ignore-scripts; npm run build; npm pack`, with the package `name` set to `@wyre-technology/node-rocketcyber`), put it in `vendor/`, and update the `file:` path in `package.json`.
