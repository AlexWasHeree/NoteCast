## What is NoteCast

NoteCast is a local engine that enriches raw notes and organizes them into an evolving knowledge graph.

Each note is automatically summarized, keyword-extracted, and embedded before it reaches the organization stage. From there, a three-stage LLM pipeline assigns it to themes, splits those themes into subtopics as they grow and rewires connections across the graph as patterns emerge.

### Why Im Building it

I have built it until now because i like to take notes, randomly and for different purposes, but I dislike keeping track of them and also any process other than take the note itself, such as categorize or organize them. Right now the code is not stable, but usable. Might have a lot of bugs and code smells and I am working on it. There are a lot of already planned features that will take this repo closer to the NoteCast I have on paper.

I appreciate feedbacks and also feel free to use it any ways you'd like.

---

## Getting Started

### 1. Install dependencies

```bash
bun install
bun link
```

`bun link` registers the `notecast` command globally. After this, `notecast <command>` works from any directory.

This includes `keyword-extractor`, the TypeScript fallback for topic extraction. Python/YAKE is attempted first, but the TS fallback is automatic — no manual setup required.

### 2. Configure an LLM provider

Save credentials first, then explicitly set the default provider — the system never auto-picks.

```bash
# Save credentials
notecast login openai        # or: anthropic, gemini, deepseek
notecast codex-login         # OAuth via ChatGPT Pro (writes token to ~/.codex/auth.json)

# Set which provider to use (required)
notecast config set defaultProvider openai   # or: anthropic, gemini, deepseek, codex, ollama
```

> **Codex credentials are machine-scoped, not project-scoped.** `codex-login` writes a token to `~/.codex/auth.json` on the local machine. Any project on the same machine picks it up automatically — no per-project setup needed. On CI or remote servers, you need to run `codex login` on that machine first.

Ollama needs no credentials — just set it as default directly:

```bash
notecast config set defaultProvider ollama
```

> **Note:** OpenAI is currently the most mature provider — best tested and most reliable across all pipeline stages.

> **Restart required:** `activeProvider` is read once at startup. Changing `defaultProvider` via `notecast config set` takes effect only after restarting the server or CLI process.

`defaultProvider` applies to all pipeline steps. Use `llmConfig` to assign different providers per step — see [Per-stage LLM config](#per-stage-llm-config) below.

### 3. Set base themes

```bash
notecast config set baseThemes '[{"name": "Tech"}, {"name": "Personal"}, {"name": "Work"}]'
```

> Should exist at least 1 theme before adding notes. A good set of initial base themes creates a better result.

> **Server mode:** `notecast start` exposes a REST API on port 3000 (configurable via `PORT`) for remote or programmatic access. The CLI talks directly to the database by default — no server needed for normal use.

---

## Pipeline

Notes move through four statuses. Each transition is handled by a different part of the system.

```
POST /notes
    │
  pending ──[Stage 1]──► processed ──[Classify]──► scanned ──[Organize]──► organized
                                                                                │
                                                              [Consolidate] ◄──┘
                                                                    │
                                                               organized (refined)
```

### Stage 1 — NoteProcessor

Runs immediately and asynchronously when a note is created. No LLM scan required — this happens in the background for every note.

For each note, it produces:

- **summary** — 2-3 sentence distillation of the content (via LLM)
- **topics** — keywords extracted via YAKE or the TS fallback
- **contentVector** — embedding of `title + content + topics`, used by the scan pipeline
- **summaryVector** — embedding of `title + summary + topics`, used for the related-notes graph

If Stage 1 fails (e.g. no LLM provider configured), the note lands in `failed`. Run `notecast retry-failed` after fixing the provider.

### Classify

Triggered automatically after every N `processed` notes (default: 10, configurable via `classifyEvery`).

- Groups `processed` notes by vector similarity before calling the LLM
- **Assign-only:** never creates new themes — only assigns notes to existing ones (base themes + subtopics created by splits)
- Each note can be assigned to 1–3 themes when it crosses domains
- Advances notes from `processed` → `scanned`

> This is why base themes must exist before notes arrive — without them, Classify has nothing to assign to.

### Organize

Triggered after every N Classify commits (default: 2, configurable via `organizeAfterClassifies`).

- Detects sub-clusters inside large themes using vector similarity
- Splits overloaded themes into subtopics (the LLM names them)
- The split threshold adapts to depth: root themes split more easily than deep ones
- After splits, notes that cross domain boundaries are assigned to multiple themes
- Advances notes from `scanned` → `organized`

### Consolidate

Triggered after every N Organize commits (default: 3, configurable via `consolidateAfterOrganizes`).

- Macro-level restructuring of the entire theme tree
- Detects co-occurrence patterns: if ≥50% of a theme's notes also appear in another theme, a parent link is added
- Removes empty themes (base themes are protected)
- The result is a **multi-parent DAG** — a theme can have more than one parent when it genuinely belongs to multiple domains

### Theme hierarchy

Themes form a directed acyclic graph (DAG), not a tree. A theme like "Cryptography" can have both "Math" and "Software" as parents. These multi-parent connections emerge organically from Consolidate — they are never assigned manually by the pipeline.

The hierarchy grows by **subdivision**: Classify only assigns, Organize and Consolidate split. Base themes are the permanent anchors; everything else is derived from the data.

---

## CLI

The CLI is the primary interface. It talks directly to the database unless `NOTES_URL` is set, in which case it proxies to the HTTP server instead.

```bash
# Notes
notecast add <file>                             # Create a note from a file (any text format)
notecast add-batch <dir>                        # Create notes from all files in a directory
notecast update <query>                         # Edit a note's source file and reprocess
notecast delete <query>                         # Delete a note by title search
notecast status                                 # Show pipeline status (counts per status)
notecast retry-failed                           # Re-enqueue notes that failed Stage 1

# Scan pipeline
notecast scan propose <classify|organize|consolidate>   # Generate a proposal
notecast scan commit [classify|organize|consolidate]    # Apply proposal (auto-detects if type omitted)

# Themes
notecast theme list
notecast theme add <name> [--parent <name-or-id>] [--desc <text>]
notecast theme update <query> [--name <n>] [--parent <p>] [--desc <d>]
notecast theme merge <source> --into <target>
notecast theme remove <query>

# Manual note ↔ theme assignment
notecast note assign <note-query> --theme <theme-query>
notecast note unassign <note-query> --theme <theme-query>

# Config
notecast config get
notecast config set <key> <value>
notecast config set vaultPath <path>            # Set Obsidian vault output folder

# Providers
notecast providers                              # Show active and available LLM providers
notecast login <provider> [key]                 # Save API key (openai|anthropic|gemini|deepseek)
notecast codex-login                            # OAuth login for ChatGPT Pro (Codex)

# Other
notecast reset [--full]                         # Soft reset (requeue scans) or full reset (delete all notes)
notecast start                                  # Start HTTP server
```

---

## API

The REST API is available when running `notecast start`. The CLI is more complete and better tested for real use — the API is provided for remote access and programmatic integrations.

### Notes

| Method   | Endpoint              | Description                                        |
| -------- | --------------------- | -------------------------------------------------- |
| `POST`   | `/notes`              | Create a note. Body: `{ title, content }`          |
| `POST`   | `/notes/batch`        | Create notes in bulk. Body: `[{ title, content }]` |
| `GET`    | `/notes`              | List all notes                                     |
| `GET`    | `/notes/:id`          | Get note by ID                                     |
| `PUT`    | `/notes/:id`          | Edit note (regresses status to `pending`)          |
| `DELETE` | `/notes/:id`          | Delete note (bidirectional cleanup)                |
| `POST`   | `/notes/retry-failed` | Re-enqueue failed notes                            |

### Themes

| Method   | Endpoint                    | Description                              |
| -------- | --------------------------- | ---------------------------------------- |
| `GET`    | `/themes`                   | List all themes                          |
| `POST`   | `/themes`                   | Create a theme                           |
| `PUT`    | `/themes/:id`               | Update theme (name, parent, description) |
| `DELETE` | `/themes/:id`               | Delete theme                             |
| `POST`   | `/themes/merge`             | Merge one theme into another             |
| `POST`   | `/themes/:id/notes/:noteId` | Assign note to theme                     |
| `DELETE` | `/themes/:id/notes/:noteId` | Remove note from theme                   |

### Scan pipeline

| Method | Endpoint                   | Description                                 |
| ------ | -------------------------- | ------------------------------------------- |
| `GET`  | `/scan/status`             | Counts per status + pending proposals       |
| `POST` | `/scan/classify`           | Generate Classify proposal                  |
| `POST` | `/scan/classify/commit`    | Apply Classify proposal                     |
| `POST` | `/scan/organize`           | Generate Organize proposal                  |
| `POST` | `/scan/organize/commit`    | Apply Organize proposal                     |
| `POST` | `/scan/consolidate`        | Generate Consolidate proposal               |
| `POST` | `/scan/consolidate/commit` | Apply Consolidate proposal                  |
| `POST` | `/scan/graph`              | Rebuild similarity graph (`relatedNoteIds`) |

### Config & system

| Method | Endpoint       | Description                        |
| ------ | -------------- | ---------------------------------- |
| `GET`  | `/config`      | Read user config                   |
| `PUT`  | `/config`      | Update config                      |
| `POST` | `/reset`       | Soft or full reset                 |
| `GET`  | `/providers`   | Active and available LLM providers |
| `GET`  | `/calibration` | Pipeline calibration metrics       |
| `GET`  | `/health`      | Health check                       |

---

## Per-stage LLM config

By default, `defaultProvider` applies to all pipeline steps. You can override provider, model, temperature, and token limit independently per step via `llmConfig`.

```bash
notecast config set llmConfig '{
  "summary":     { "provider": "ollama", "model": "llama3.2:3b" },
  "classify":    { "provider": "openai",  "model": "gpt-4o-mini", "temperature": 0.2 },
  "organize":    { "provider": "openai",  "model": "gpt-4o" },
  "consolidate": { "provider": "openai",  "model": "gpt-4o" },
  "embedding":   { "provider": "ollama",  "model": "nomic-embed-text" }
}'
```

Each key is optional — omit a step to inherit `defaultProvider`. The five configurable steps are:

| Step          | What it does                                      |
| ------------- | ------------------------------------------------- |
| `summary`     | Generates the 2-3 sentence note summary (Stage 1) |
| `classify`    | Assigns notes to themes                           |
| `organize`    | Splits themes into subtopics                      |
| `consolidate` | Macro restructuring of the theme tree             |
| `embedding`   | Produces vectors for all notes (Stage 1)          |

`embedding` only accepts `provider` and `model` (no temperature or token limit).

**Override individual steps** (e.g. local embeddings + cloud for scans):

```bash
notecast config set llmConfig '{"embedding":{"provider":"ollama","model":"nomic-embed-text"}}'
```

---

## Optional Dependencies

### Python + YAKE (topic extraction)

The service extracts topics from each note during Stage 1. It tries Python/YAKE first and silently falls back to the bundled `keyword-extractor` (TypeScript) if Python is unavailable. No configuration needed — the fallback is automatic.

```bash
pip install yake
```

YAKE tends to produce cleaner, more linguistically aware keywords. The TS fallback works fine for most use cases.

### Ollama (local LLM inference)

Ollama lets you run pipeline stages locally. Install from [ollama.com](https://ollama.com), then configure it as a provider via `notecast config set defaultProvider ollama` or per-step via `llmConfig`.

---

## Vault Sync

When `vaultPath` is set, the service syncs the full state of the database to a folder on the filesystem after every scan commit, note creation, or edit. The output is Obsidian-compatible but works as plain markdown in any editor.

### Setup

```bash
notecast config set vaultPath ~/my-vault
# or an absolute path
notecast config set vaultPath /Users/you/Documents/my-vault
```

Use `~` or an absolute path. Relative paths (e.g. `./vault`) are resolved against the working directory at sync time, which can vary — avoid them.

### What gets written

```
<vaultPath>/
├── Themes/
│   ├── Tech.md          # one file per theme
│   ├── Software.md
│   └── ...
├── Source/
│   └── ...              # source files (notecast added via `notecast add <file>`)
├── Proposals/
│   └── classify-proposal.json   # saved here when vaultPath is set; otherwise saved as ./proposal-<type>.json in the working directory
└── _Dashboard.md        # pipeline status + theme graph metrics
```

**Theme files** contain parent/child wikilinks, a list of assigned notes, and frontmatter tags:

| Tag           | Meaning                     |
| ------------- | --------------------------- |
| `theme`       | all themes                  |
| `root`        | no parents (top of the DAG) |
| `leaf`        | no children                 |
| `multiparent` | belongs to 2+ parent themes |
| `large`       | more than 10 notes          |
| `empty`       | no notes assigned           |

**Source files** — files added via `notecast add <file>` are **moved** to `Source/` (the original path is no longer available after the command). The file content is never modified by the pipeline. If `vaultLinks` is enabled, a `related:` YAML frontmatter block is injected with wikilinks to semantically similar notes after the graph is built — only that block is touched, the rest of the file is untouched. `vaultLinks` is `false` by default; enable it with `notecast config set vaultLinks true`. Non-markdown files are moved and stored correctly, but Obsidian wikilinks and graph rendering only work with `.md` files.

**`_Dashboard.md`** shows pipeline counts, theme graph depth stats, note coverage, health warnings (empty/large themes), and a delta of themes added or removed in the last sync.

### Obsidian setup

The syncer writes `.obsidian/graph.json` with default color groups on first run (themes in blue, large themes in red, orphans in orange). It never overwrites the file if it already exists, so your customizations are preserved.

---

## Configuration Reference

All config is stored in the database and managed via `notecast config set <key> <value>` or `PUT /config`.

### Providers

| Field             | Type                                                           | Default | Description                                                            |
| ----------------- | -------------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `defaultProvider` | `openai \| anthropic \| gemini \| deepseek \| codex \| ollama` | —       | Provider used for all pipeline steps unless overridden                 |
| `llmConfig`       | object                                                         | —       | Per-step overrides — see [Per-stage LLM config](#per-stage-llm-config) |

### Pipeline triggers

| Field                                      | Type   | Default | Description                                         |
| ------------------------------------------ | ------ | ------- | --------------------------------------------------- |
| `pipelineConfig.classifyEvery`             | number | `10`    | Number of `processed` notes that trigger Classify   |
| `pipelineConfig.organizeAfterClassifies`   | number | `2`     | Number of Classify commits that trigger Organize    |
| `pipelineConfig.consolidateAfterOrganizes` | number | `3`     | Number of Organize commits that trigger Consolidate |

### Themes

| Field                   | Type                                                   | Default        | Description                                                                |
| ----------------------- | ------------------------------------------------------ | -------------- | -------------------------------------------------------------------------- |
| `baseThemes`            | `{ name, description? }[]`                             | `[]`           | Anchor themes; Classify only assigns to these (and their subtopics)        |
| `themeStyle`            | `single-word \| short-phrase \| descriptive \| custom` | `short-phrase` | Naming style for LLM-generated theme names                                 |
| `themeStyleInstruction` | string                                                 | —              | Free-form instruction for theme naming, used when `themeStyle` is `custom` |

### Content & language

| Field      | Type                    | Default   | Description                                                                                                        |
| ---------- | ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `language` | `english \| portuguese` | `english` | Language for scan prompts and keyword extraction                                                                   |
| `context`  | string                  | —         | Free-form text injected into every scan prompt — use it to describe your domain, focus areas, or note-taking style |

### Output

| Field       | Type   | Default | Description                                        |
| ----------- | ------ | ------- | -------------------------------------------------- |
| `vaultPath` | string | —       | Filesystem path for Obsidian-compatible vault sync |
| `vaultLinks` | boolean | `false` | Inject `related:` wikilinks into source files after the graph is built |

---

## Environment Variables

| Variable            | Default        | Description                                                                                |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `PORT`              | `3000`         | HTTP server port (`notecast start`)                                                        |
| `NOTES_DB_PATH`     | `./notes.db`   | SQLite database file path                                                                  |
| `LANCEDB_PATH`      | `<db>.lancedb` | LanceDB vector store path (defaults to same location as the SQLite file)                   |
| `NOTES_URL`         | —              | When set, the CLI proxies to this remote server instead of accessing the database directly |
| `OPENAI_API_KEY`    | —              | OpenAI API key (alternative to `notecast login openai`)                                    |
| `ANTHROPIC_API_KEY` | —              | Anthropic API key                                                                          |
| `GEMINI_API_KEY`    | —              | Gemini API key                                                                             |
| `DEEPSEEK_API_KEY`  | —              | DeepSeek API key                                                                           |
