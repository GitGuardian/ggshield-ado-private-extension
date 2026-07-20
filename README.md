# ggshield for Azure Pipelines (private decorator extension)

Scaffold for an Azure DevOps extension that lets you share a single ggshield API key across every pipeline in an organization — without editing each YAML or routing through variable groups / Key Vault. It ships:

1. A **custom task** (`ggshield@0`) that reads credentials from a typed Generic service connection (`connectedService:Generic`) — the only ADO context where endpoint fields actually resolve in YAML pipelines.
2. A **pipeline decorator** that auto-injects that task right after the implicit `checkout` step of every agent job.

## Prerequisites

- Node.js 18+ and npm
- `tfx-cli` — `npm install -g tfx-cli`
- A publisher account on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage)

## Configure

In `vss-extension.json`:

- Replace `REPLACE-WITH-YOUR-PUBLISHER-ID` with your Marketplace publisher ID. **Required** — `tfx` will refuse to package otherwise, and the `.vsix` filename encodes this value.
- Bump the top-level `version` for each release. The build script intentionally does not auto-bump.

### Versioning: one number to bump

ADO tracks two versions for this kind of extension: `vss-extension.json` → `version` (drives Marketplace upgrade detection) and `ggshield-scan-task/task.json` → `version: { Major, Minor, Patch }` (drives whether agents pull new task bits). They must agree, or you get a stale task on agents or a rejected upload.

**Edit only `vss-extension.json`'s `version`.** `build.sh` parses it and rewrites the `Major/Minor/Patch` block in `task.json` before packaging — commit both files together.

## Build

```bash
./build.sh
```

Output: a `.vsix` in the project root, named `<publisher>.ggshield-ado-private-extension-<version>.vsix`.

## Publish privately

1. Go to https://marketplace.visualstudio.com/manage and upload the `.vsix`. The extension shows up under your publisher with **Availability: Private (shared with…)**:

   ![Marketplace publisher portal showing the private extension](images/marketplace-publisher-portal.png)
2. Click `...` → **Share/Unshare** and add your ADO organization (e.g. `https://dev.azure.com/myorg`).
3. In your ADO org: **Organization Settings → Extensions → Shared** → click the extension → **Install**:

   ![Azure DevOps Organization Settings → Extensions → Shared](images/ado-shared-extensions.png)

Private extensions are **not** reviewed by Microsoft and become available to the target org immediately after sharing.

## Configure a service connection

In the target ADO project: **Project Settings → Service connections → New service connection → Generic**, then:

- **Server URL**: your GitGuardian **dashboard** URL — `https://dashboard.gitguardian.com` (SaaS US), `https://dashboard.eu1.gitguardian.com` (SaaS EU), or your self-hosted dashboard URL. ggshield derives the API URL from this; **passing the API URL directly will fail to authenticate**. Leave blank for the SaaS US default.
- **Username**: leave blank.
- **Password/Token Key**: your ggshield API key.
- **Service connection name**: `gitguardian-api` **(must match exactly — the decorator YAML references this name)**.
- Tick **Grant access permission to all pipelines**.

![Generic service connection configured for ggshield](images/service-connection-generic.png)

## Test

1. In a throwaway repo, create a minimal `azure-pipelines.yml`:

   ```yaml
   trigger: [main]
   pool:
     vmImage: ubuntu-latest
   steps:
     - script: echo "my real build steps go here"
   ```
2. Run the pipeline — a `ggshield - secret scan` step should appear right after `Checkout`.
3. Add a hardcoded test secret to verify the env-var plumbing; the scan should fail the build:

   ![Pipeline run showing ggshield detecting a hardcoded MongoDB URI](images/pipeline-scan-result.png)

### Opt-out for a specific pipeline

```yaml
variables:
  skipGGShield: true
```

Useful for the pipeline that builds this extension itself (otherwise you'll get infinite recursion of self-scans).

## Before rolling out org-wide

The decorator fires on every agent job in every pipeline, so a broad rollout meaningfully increases ggshield API traffic. Those calls are subject to **API rate limits** shared across your workspace — review your quotas and headroom first: [usage, quotas, and rate limiting](https://docs.gitguardian.com/api-docs/usage-and-quotas#rate-limiting).

**Built-in safety net.** The task's `scanTimeoutSeconds` input (default `80`) terminates ggshield and completes the step as `SucceededWithIssues` when the scan runs long. This contains rate-limit incidents: `pygitguardian` retries `429`s indefinitely, so without the cap a transient event would turn into an org-wide pipeline outage. Tune it down (e.g. `30`) on fast pipelines, or up for large monorepos.

## Known limits of this scaffold

- ggshield is auto-installed on demand if missing. The task tries `pipx`, then `python3 -m pip`, `python -m pip`, `pip3`, `pip`, in that order. Bake ggshield into self-hosted agent images to remove ~5s of cold-start overhead per job.
- Windows-hosted agents need Python 3.8+ on `PATH` for the auto-install fallback.
- The decorator fires on every agent job; gate by branch or path with `${{ if ... }}` in `decorator/ggshield-decorator.yml` if needed.

## Future ideas

- Publish scan results as an artifact / custom tab in the run summary.
- JSON → SARIF conversion for the ADO security UI.
