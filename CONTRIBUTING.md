# Contributing to Engram

Thanks for wanting to contribute! Engram is early-stage and moving fast — contributions are welcome.

## Getting Started

```bash
git clone https://github.com/tstockham96/engram.git
cd engram
npm install
npm test        # Run all tests (59 and counting)
npm run lint    # Type check
```

## Development

```bash
npm run cli -- remember "test memory"   # Test CLI
npm run cli -- recall "test"            # Test recall
npm run serve                           # Start REST API on :3800
npm test                                # Run tests
```

## What We Need Help With

- **Python SDK** — thin client wrapping the REST API
- **Framework integrations** — OpenClaw, LangChain, CrewAI, AutoGen adapters
- **Consolidation improvements** — smarter rule-based consolidation, better LLM prompts
- **Embedding providers** — Voyage, Cohere, local models
- **Documentation** — examples, tutorials, guides
- **Testing** — edge cases, stress tests, benchmarks

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Add tests for any new functionality
3. Make sure all tests pass (`npm test`)
4. Make sure types check (`npm run lint`)
5. Keep PRs focused — one feature or fix per PR
6. Write a clear description of what and why

## Code Style

- TypeScript, strict mode
- Use Zod for input validation
- Tests in `src/__tests__/` using Vitest
- No external runtime dependencies without discussion (we're at 4 deps total — let's keep it lean)

## Architecture Decisions

- **Zero-dependency server**: The REST API uses Node's built-in `http` module, not Express/Hono/Fastify. This is intentional — fewer deps = fewer supply chain risks.
- **SQLite**: Single-file database, no server setup. sqlite-vec for vector search.
- **Local-first**: Everything runs on your machine by default. Cloud is opt-in.

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected
- What happened instead
- Steps to reproduce
- Node version, OS

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
