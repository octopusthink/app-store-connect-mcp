# App Store Connect MCP

An [MCP](https://modelcontextprotocol.io) server for Apple's [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi). It lets Claude, Claude Code and other AI agents work with your apps' metadata, App Store versions and review submissions, builds and TestFlight, customer reviews, sales and finance reports, Xcode Cloud, devices and team members.

- **36 tools.** Task-shaped tools cover the common workflows. Three generic tools (`search_endpoints`, `describe_endpoint`, `api_request`) reach the rest of Apple's 1,300+ endpoints through the bundled OpenAPI spec.
- **Runs locally with `npx`.** Your private key stays on your machine and is only used to sign short-lived tokens for `api.appstoreconnect.apple.com`.
- **Optional read-only mode** hides every tool that changes data.

## Requirements

- Node.js 24 or later
- An App Store Connect **team API key**

## Create an API key

1. In [App Store Connect](https://appstoreconnect.apple.com), go to **Users and Access → Integrations → App Store Connect API**.
2. Click **Generate API Key** (or **+**). Give it a name and pick a role:
   - **App Manager** covers most tools: metadata, versions, TestFlight, reviews and Xcode Cloud.
   - Reports need a role with report access: **Sales** or **Finance** for `get_sales_report`, **Finance** for `get_finance_report`.
   - If a tool returns a 403 error, the key's role doesn't allow that request.
3. Download the `AuthKey_XXXXXXXXXX.p8` file. Apple only lets you download it once.
4. Note the **Key ID** (shown next to the key) and the **Issuer ID** (shown above the list of keys).
5. For sales and finance reports, also note your **vendor number**. It's shown at the top left of **Payments and Financial Reports** in App Store Connect.

## Set up

The server reads these environment variables. The first three are required:

| Variable                          | Value                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `APP_STORE_CONNECT_ISSUER_ID`     | Your Issuer ID, e.g. `57246542-96fe-1a63-e053-0824d011072a`                               |
| `APP_STORE_CONNECT_KEY_ID`        | Your Key ID, e.g. `2X9R4HXF34`                                                            |
| `APP_STORE_CONNECT_PRIVATE_KEY`   | The contents of the `.p8` file, as text                                                   |
| `APP_STORE_CONNECT_VENDOR_NUMBER` | Optional. Your vendor number, e.g. `85012345`, used by the sales and finance report tools |
| `APP_STORE_CONNECT_READ_ONLY`     | Optional. `true` hides all write tools                                                    |

The private key can be pasted as a normal multi-line PEM, as a single line with `\n` escapes (as JSON configs need), or as just the base64 body without the `BEGIN`/`END` lines.

### Claude Code

```bash
claude mcp add app-store-connect --scope user \
  -e APP_STORE_CONNECT_ISSUER_ID=your-issuer-id \
  -e APP_STORE_CONNECT_KEY_ID=your-key-id \
  -e APP_STORE_CONNECT_PRIVATE_KEY="$(cat ~/Downloads/AuthKey_XXXXXXXXXX.p8)" \
  -e APP_STORE_CONNECT_VENDOR_NUMBER=your-vendor-number \
  -- npx -y @octopusthink/app-store-connect-mcp
```

The vendor number line is optional: leave it out if you don't need sales or finance reports. Leave out `--scope user` to add the server to the current project only. Run `/mcp` inside Claude Code to check it connected.

### Claude Desktop

Open **Settings → Developer → Edit Config** and add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "app-store-connect": {
      "command": "npx",
      "args": ["-y", "@octopusthink/app-store-connect-mcp"],
      "env": {
        "APP_STORE_CONNECT_ISSUER_ID": "your-issuer-id",
        "APP_STORE_CONNECT_KEY_ID": "your-key-id",
        "APP_STORE_CONNECT_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49...\n-----END PRIVATE KEY-----",
        "APP_STORE_CONNECT_VENDOR_NUMBER": "your-vendor-number"
      }
    }
  }
}
```

JSON strings can't contain real line breaks, so the key's newlines become `\n`. This command prints your key in that form:

```bash
awk 'NF { sub(/\r/, ""); printf "%s\\n", $0 }' ~/Downloads/AuthKey_XXXXXXXXXX.p8
```

Restart Claude Desktop after saving.

### Other MCP clients

Run `npx -y @octopusthink/app-store-connect-mcp` as a stdio server with the environment variables above.

## What you can ask

- "Which of my apps have a version waiting for review?"
- "Show me this week's 1- and 2-star reviews for Example and draft replies."
- "Create version 2.1 of Example, use the latest build, and set the release notes to …"
- "Add build 2.1 (57) to the Beta Testers group and set the test notes."
- "Invite sam@example.com to the Internal QA TestFlight group."
- "How many units did we sell yesterday?" (uses your vendor number)
- "Start an Xcode Cloud build of the Release workflow on main."
- "Set up a phased release for the current version." (through `api_request`)

## Tools

Tools marked ✏️ change data. They are annotated as such, so MCP clients can ask you before running them.

**Apps**: `list_apps`, `get_app`

**App Store versions and metadata**
- `list_app_store_versions`, `list_version_localizations`, `list_app_info_localizations`
- ✏️ `create_app_store_version`: new version for a platform
- ✏️ `update_version_localization`: description, keywords, what's new, promotional text, URLs (adds the locale if missing)
- ✏️ `update_app_info_localization`: name, subtitle, privacy URLs
- ✏️ `select_build_for_version`: attach a build
- ✏️ `submit_for_review`: submit to App Review

**Builds and TestFlight**
- `list_builds`, `get_build`, `list_beta_groups`, `list_beta_testers`
- ✏️ `add_build_to_beta_groups`, `set_build_test_notes`, `submit_build_for_beta_review`
- ✏️ `invite_beta_tester`, `remove_beta_tester_from_groups`

**Customer reviews**
- `list_customer_reviews`, including any response already posted
- ✏️ `respond_to_review`, `delete_review_response`

**Reports**: `get_sales_report`, `get_finance_report`

**Xcode Cloud**
- `list_ci_products`, `list_ci_workflows`, `list_ci_build_runs`, `get_ci_build_run`
- ✏️ `start_ci_build`

**Provisioning and team**
- `list_bundle_ids`, `list_devices`, `list_users`
- ✏️ `register_device`

**Everything else**
- `search_endpoints`: keyword search over every endpoint in Apple's OpenAPI spec
- `describe_endpoint`: parameters, allowed values and the full request body schema for one endpoint
- ✏️ `api_request`: call any endpoint, with optional pagination. GET only in read-only mode.

List tools return a `nextCursor` when there are more results; pass it back as `cursor` to get the next page. Responses are flattened from Apple's JSON:API format to save tokens.

## Read-only mode

Set `APP_STORE_CONNECT_READ_ONLY=true` to remove every write tool and limit `api_request` to GET requests. This mode is enforced by the server. App Store Connect itself enforces only the key's role, so also give the key the narrowest role that covers what you need.

## Security

- The private key is read from the environment and never logged or returned by any tool.
- Tokens are signed locally (ES256, 19-minute lifetime) and only sent to `https://api.appstoreconnect.apple.com`. The server refuses requests to any other host, including pagination URLs passed in by the model.
- Write tools carry MCP annotations (`readOnlyHint: false`, plus `destructiveHint` for deletions and submissions) so clients can ask for confirmation.
- Use the narrowest role that covers what you need, and revoke the key in App Store Connect if it leaks.

## Development

```bash
npm install
npm test            # unit tests and a stdio end-to-end test
npm run lint        # Biome
npm run typecheck   # TypeScript 7
npm run build       # compiles to dist/
npm run inspect     # opens the MCP Inspector against the built server
npm run dev         # runs src/index.ts directly with Node's type stripping
```

`npm run update-spec` downloads the latest App Store Connect OpenAPI spec from Apple into `spec/openapi.json.gz`, which `search_endpoints` and `describe_endpoint` read.

The code is organized as follows:

- `src/config.ts`: environment variables and private key parsing
- `src/auth.ts`: JWT signing
- `src/client.ts`: the HTTP client, with retries, errors, pagination and gzip reports
- `src/format.ts`: JSON:API flattening
- `src/spec.ts`: endpoint search and description over the bundled spec
- `src/tools/`: one file per area, all registered in `src/tools/index.ts`

To add a tool, define it with `defineTool` in the relevant file and add it to that file's exported list. Set `write: true` for anything that changes data.

## Releasing

Pushing a version tag such as `1.2.3` (no `v` prefix) runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which runs the full CI checks, confirms the tag matches the `package.json` version, and publishes to npm. Versions with a prerelease suffix, such as `1.3.0-beta.1`, are published under the `next` dist-tag, so `npx` users stay on the latest stable release.

The workflow uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): npm accepts GitHub's short-lived OIDC token from this workflow, so no npm token is stored in GitHub.

### One-time setup

1. **Publish the first version by hand.** Trusted publishing is configured per package, so the package has to exist on npm first. From a clean checkout of the version you want to release, run:

   ```bash
   npm login
   npm publish
   ```

   `npm publish` runs the lint, typecheck, tests and build first. `package.json` already sets `"access": "public"` for the scoped package. Don't push a tag for this version: the workflow would try to publish it again, and npm rejects duplicate versions.
2. **Add the trusted publisher.** On npmjs.com, open the package's **Settings → Trusted publishing**, choose **GitHub Actions**, and enter:
   - Organization: `octopusthink`
   - Repository: `app-store-connect-mcp`
   - Workflow filename: `release.yml`
   - Environment: `npm`
3. **Optional: lock it down.**
   - In the package's **Settings → Publishing access** on npm, choose **Require two-factor authentication and disallow tokens**. The workflow keeps working, because it doesn't use a token.
   - In this repository's **Settings → Environments → npm** on GitHub, add required reviewers so every release waits for approval.

Provenance attestations are only generated for public repositories. They'll start appearing automatically if this repository is made public.

### Each release

```bash
npm version patch   # or minor, major, prerelease --preid beta
git push --follow-tags
```

`npm version` bumps `package.json`, commits, and creates the matching tag, such as `1.2.4`. The project's `.npmrc` sets `tag-version-prefix=""`, so npm doesn't add its usual `v`. Pushing the tag starts the release.

## License

MIT
