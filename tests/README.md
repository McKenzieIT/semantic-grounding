# Tests

Ported from `deepseek-harness-da/packages/data/semantic-layer/tests/` (20 spec
files, 269 tests). Run with `pnpm test` (vitest).

## k11 fixture (`tests/fixtures/k11/`)

The k11 corpus is copied verbatim from
`deepseek-harness-da/examples/k11-semantic-layer/` and committed under
`tests/fixtures/k11/`. The ported specs reference it via a single relative
path (`join(HERE, './fixtures/k11')` from `tests/*.spec.ts`), replacing the
upstream's four-levels-up `../../../../examples/k11-semantic-layer` path.

### Trim

The ticket called for trimming the corpus to "the subset actually exercised by
the ported tests." That subset is the **complete corpus**: `k11-seed.spec.ts`
asserts exact counts that require the full directory —

- `loadEvents` returns **445** events (from 453 event YAML files: 446
  definitions − 1 malformed duplicate-key file; 7 `_index` files skipped by
  the loader).
- `loadTables` returns **321** tables (162 DWS + 159 DIM).
- `loadRetrievalCorpus` returns **445** items (events only).

So `events/` (453 files) and `tables/` (321 files) cannot be reduced without
breaking the count assertions, and `concepts/` (10 files) is loaded in full by
`concept-kind.spec.ts`. `config.yaml` and `domains.yaml` are loaded by
`loadConfig` / `loadDomains`.

The one file **not** exercised by any loader or test is `field_samples.yaml`
— it is the sole trim (787 → 786 files). Further reduction would require
relaxing the count assertions above or synthesizing a smaller fixture; both
are deferred to a follow-up.

| kept | trimmed |
| --- | --- |
| `events/` (453), `tables/` (321), `concepts/` (10), `config.yaml`, `domains.yaml` | `field_samples.yaml` |
