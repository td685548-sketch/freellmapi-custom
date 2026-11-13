# AI Agent Guidelines & Upstream Synchronization Strategy

> **For all AI Coding Agents (Cursor Agent, Claude Code, Cline, Antigravity, Copilot, Codex, OpenCode):**  
> This repository is a custom extension of the upstream open-source project **FreeLLMAPI**. Read and strictly follow the architecture rules and synchronization workflow defined below before making any changes.

---

## 1. Repository Topology

| Remote Name | Repository URL | Purpose |
| :--- | :--- | :--- |
| **`origin`** | `https://github.com/emyeutruongem/freellmapi-custom.git` | **Main Workspace**: Where custom features, invite-system, and extensions live. All feature commits are pushed here. |
| **`upstream`** | `https://github.com/tashfeenahmed/freellmapi.git` | **Original Source**: The official FreeLLMAPI repository. Used strictly as a read-only source for pulling updates and bug fixes. |

---

## 2. Zero-Conflict Modular Design Rules (MANDATORY)

When implementing custom features (e.g., Invite Code System, Multi-User RBAC, Per-User Quotas):

### Rule 1: Standalone Files First
- **Services**: Create new files under `server/src/services/` (e.g. `invites.ts`, `user-quotas.ts`). Do not bloat existing service files like `auth.ts` or `proxy.ts`.
- **Routes / Controllers**: Create new router files under `server/src/routes/` (e.g. `invites.ts`).
- **Database Migrations**: ALWAYS generate a new timestamped migration file under `server/src/db/migrations/` (e.g., `YYYYMMDD_HHMMSS_custom_invites.ts`). **NEVER modify existing upstream migration files.**
- **Frontend Components**: Create dedicated components or pages under `client/src/` (e.g. `client/src/pages/Invites.tsx`).

### Rule 2: Minimal Touch Points on Upstream Files
When connecting your custom module to the existing application:
- Only touch the entry points (e.g., adding `app.use('/api/invites', invitesRouter)` in `server/src/app.ts`, or adding a navigation tab in the sidebar).
- Keep changes to existing files small, clean, and isolated.
- **NEVER** reformat, lint-fix, or refactor unrelated upstream code.

### Rule 3: Backward Compatibility with Existing Deployments
- Preserve all existing public endpoints (`/v1/*`, `/livez`, `/readyz`, `/api/ping`).
- Ensure single-user Docker / local deployment setups continue to function without errors.

---

## 3. Upstream Synchronization Workflow

Whenever instructed to "update from upstream", "sync with main repo", or pull latest changes from the original repository:

### Step 1: Pre-Sync Check
Ensure the local working directory is clean:
```powershell
git status
```
If there are uncommitted changes, commit or stash them before proceeding.

### Step 2: Fetch and Merge Upstream
```powershell
# 1. Fetch latest commits and tags from official upstream
git fetch upstream

# 2. Merge upstream/main into the current working branch (main)
git merge upstream/main
```

### Step 3: Conflict Handling (If Any)
Due to Rule 1 and Rule 2, merge conflicts should be rare. If a conflict occurs on an entry point (e.g., `server/src/app.ts` or `package.json`):
1. **Preserve Both**: Keep upstream's updates while preserving the custom router mounting or package dependency.
2. **Do Not Drop Custom Features**: Never discard custom modules in favor of upstream defaults.
3. Test the build immediately:
   ```powershell
   npm run build
   npm run test
   ```

### Step 4: Push Merged State to Origin
```powershell
git push origin main
```

---

## 4. Spec Kit & SDD Workflow

This repository uses **Spec Kit** for Specification-Driven Development:
- Configuration: `.specify/`
- Constitution: `.specify/memory/constitution.md`
- Skills: `.cursor/skills/`, `.claude/skills/`, `.clinerules/workflows/`

When asked to implement a new feature:
1. Run `/speckit-specify <description>` to generate the specification.
2. Run `/speckit-plan` to design the technical architecture.
3. Run `/speckit-tasks` to break down into actionable tasks.
4. Run `/speckit-implement` to execute code changes following the Zero-Conflict rules above.

---

## 5. Branching, Pull Request & Merge Workflow (MANDATORY)

To keep the `main` branch stable, ensure clean CI validation, and preserve full traceability:

### Rule 1: One Dedicated Branch per Feature or Fix
**Never commit or push features or fixes directly to `main`. Every new feature, bug fix, or independent maintenance task gets its own branch from the latest `origin/main`.** This applies to 9Router integration too; there is no shared integration-branch exception.

```powershell
git fetch origin
git switch -c <type>/<short-description> origin/main
# Examples: feat/support-service-desk, fix/kiro-client-version, chore/branch-policy
# Codex-created branches use the codex/ prefix by default.
```

- Do not reuse `feat/9router-integration` or another completed task's branch for new work.
- Keep one task's follow-up review corrections on that task's dedicated branch and PR. Start a new branch for a different feature or fix.
- Never share an active branch between independent tasks or parallel agent assignments. Each implementation agent uses its own branch/checkout; the reviewer integrates accepted commits into the feature's review branch.
- Before switching, preserve pending work. If the current checkout contains unrelated changes, use a suitable isolated checkout rather than resetting, stashing, or moving someone else's work.
- One feature/fix scope per PR, targeting `main`. Reuse a PR only for follow-up changes to that same task; never append another task to an unrelated open PR.
- Existing open PRs keep their current branches until completed; do not rename, overwrite, or merge them merely to start a different task.
- Run the required tests/build and require green CI before merging. Branch isolation does not relax validation or authorize an automatic merge.

### Rule 2: Verify Tests and Build
Before committing or creating a PR, verify that the workspace passes all tests and builds:
```powershell
npm run test
npm run build
```

### Rule 3: Push Branch and Create Pull Request
Push the branch to `origin` and use the GitHub CLI (`gh`) to open a Pull Request targeting `main`:
```powershell
git push -u origin <branch-name>
gh pr create --base main --head <branch-name> --title "<type>(<scope>): <summary>" --body "<description of changes>"
```

### Rule 4: Merge PR and Sync Local Main
Merge the Pull Request into `main` and sync your local repository:
```powershell
gh pr merge <pr-number-or-branch> --merge
git checkout main
git pull origin main
```

---

## 6. GitHub Terms of Service, CI Safety & Abuse Prevention Guidelines (MANDATORY)

> **CRITICAL LESSON FROM INCIDENT (11/2026):**  
> Read the complete post-mortem and compliance rules in [`docs/GITHUB_COMPLIANCE_AND_SAFETY_GUIDE.md`](docs/GITHUB_COMPLIANCE_AND_SAFETY_GUIDE.md). All AI agents and developers must strictly follow these safeguards:

### Rule 1: Zero Tunneling or Prohibited Utilities in CI Workflows
- **NEVER** download, run, or package tunneling binaries (such as `ngrok`, `cloudflared`, `frp`, `pinggy`, `tor`, or reverse shells) on GitHub Actions runners.
- Any project requiring external network tunneling tools or native APK assembly with third-party network binaries must build **100% locally** on development machines via scripts, never on cloud CI runners.

### Rule 2: Ban on Binary Executables in Git Tracking
- **NEVER** commit executable binary files (`.apk`, `.so`, `.exe`, `.dll`, `.ipa`, `.idsig`) into Git repositories.
- Always enforce proper exclusions in `.gitignore`. Distribute binaries only through official GitHub Releases.

### Rule 3: Neutral Technical & Academic Documentation
- **NEVER** use aggressive or blacklisted scraping/proxy terminology in public `README.md` or repository descriptions (e.g., *"Bypass Cloudflare"*, *"Bypass bot protection"*, *"Residential proxy farm"*, *"Scraping tools"*).
- Always use standard software engineering and academic language (e.g., *"Local Development & Testing Gateway"*, *"Network Sockets Research"*, *"Resilient HTTP Client"*).

### Rule 4: No Rapid-Fire Ban Evasion Accounts
- If an account is suspended or under manual review, **DO NOT** create alternate accounts and immediately push dozens of repositories from the same environment/IP. This triggers GitHub's automated abuse filters, secondary rate limits, and cascading suspensions.
- Resolve account issues through official support channels with clear academic and educational context.

