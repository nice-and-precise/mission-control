# Contributing to Mission Control

Thank you for your interest in contributing to Mission Control.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<you>/mission-control.git`
3. Install dependencies: `nvm use && npm ci`
4. Copy config: `cp .env.example .env.local`
5. Seed the database: `npm run db:seed`
6. Start dev server: `npm run dev`

## Development Workflow

### Branching

- Create feature branches from `main`: `git checkout -b feature/my-change`
- Use conventional branch prefixes: `feature/`, `fix/`, `chore/`, `docs/`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add workspace model override UI
fix: correct agent health timeout calculation
docs: update autopilot setup guide
chore: bump dependencies
```

### Testing

Run the full test suite before submitting a PR:

```bash
npm test
```

For runtime-targeted tests (agent health, tasks, sessions):

```bash
npm run test:runtime-targeted
```

### Linting & Docs

```bash
npm run lint
npm run docs:check
```

## Pull Requests

1. Keep PRs focused — one logical change per PR
2. Include a clear description of what changed and why
3. Reference any related issues
4. All CI checks must pass (Branch Policy, Docs, Test, Build)
5. Update documentation if your change affects user-facing behavior

## Code Style

- TypeScript strict mode
- Zod for runtime validation at API boundaries
- `better-sqlite3` for database access (no ORM)
- Server Components by default; Client Components only when needed
- Tailwind CSS for styling

## Architecture Notes

- **API routes** live in `src/app/api/` — Next.js App Router conventions
- **Core logic** lives in `src/lib/` — pure functions, no React imports
- **Autopilot logic** lives in `src/lib/autopilot/` — research, ideation, swipe, scheduling
- **OpenClaw integration** lives in `src/lib/openclaw/` — gateway client, sessions, routing
- **Database migrations** in `src/lib/db/` — auto-run on startup, never destructive

## Reporting Issues

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Node version (`node -v`), OpenClaw version (`openclaw --version`)
- Relevant logs from the browser console or terminal

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
