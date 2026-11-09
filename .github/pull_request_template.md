## Description

<!-- Provide a clear and concise description of the changes in this pull request. -->

## Associated Issue / Jira Story

- Issue / Story: `LAB-` <!-- e.g. LAB-123 -->

## Type of Change

- [ ] `feat`: New feature or capability
- [ ] `fix`: Bug fix
- [ ] `perf`: Performance improvement
- [ ] `chore`: Tooling, configuration, or dependency updates
- [ ] `docs`: Documentation updates
- [ ] `test`: Test additions or test infrastructure improvements
- [ ] `refactor`: Code change that neither fixes a bug nor adds a feature

## Verification Checklist

Please verify before requesting review:

- [ ] **Tests pass:** `npm test`
- [ ] **Typecheck passes:** `npm run typecheck`
- [ ] **Lint passes:** `npm run lint` (0 errors)
- [ ] **Build passes:** `npm run build`
- [ ] **Layering compliance:** Core logic in `src/core` does not import Next.js or database modules (see `ARCHITECTURE.md`)
- [ ] **Git conventions:** Conventional commit format, no `Co-Authored-By` / AI attribution trailers, clean branch history
