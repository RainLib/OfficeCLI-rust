# Ironpress agent guardrails

## Writing Rust code

- Structure state so that invalid state is unrepresentable in the type system.
- Do not validate; parse. Turn raw input into a richer type once, at the boundary; past that boundary the type is proof the data is well-formed.
- Use semantic types that carry meaning and reusable functionality instead of abusing meaningless scalars. Group fields by domain responsibility; copying a flat field list from an enum variant into a flat struct is not a semantic refactor.
- Do not use interior mutability or reference counting. They normally indicate that ownership has not been modeled correctly; prefer owned values, `&`, and `&mut`.
- Production code must never panic. Tests may panic when an assertion fails.
- Keep code simple. Long or complicated code indicates a missing abstraction; use the type system to represent prevalidated states instead of propagating `Result` or `Option` without semantic need.
- Do not reinvent functionality that an appropriate, well-maintained crate already provides.
- Establish every test expectation from an independent requirement, applicable specification, verified oracle, or reproduced regression before changing implementation. Never rewrite a test merely to match the code's new output; delete a test with no independently known behavioral contract instead of using it to bless the implementation.
- Diagnostics for parsed languages must explain what went wrong, why, and how to fix it when a useful hint exists.
- Avoid noisy code and keep each function at a homogeneous abstraction level. Every statement should contribute to understanding the computation.
- Avoid bare helper functions when the behavior belongs on a type or is shared through a trait.
- When multiple structures provide common behavior and a consumer does not care which structure backs it, constrain that behavior with a trait and implement the trait on each structure.
- Do not use field-bearing object-enum leaves. Model each leaf as a concrete struct. If the object family is open or consumers depend on shared behavior, use a trait (with `Box<dyn Trait>` and an object-safe visitor or narrower capability traits where heterogeneous storage or dispatch is required). Keep enums only for genuinely closed value/state alternatives, not as substitutes for behavior-bearing types.
- Group reusable contextual values into semantic structs with their own constructors, operators, helpers, and `Default` implementations. Prefer `Struct { nondefault: value, ..Default::default() }` over repeating neutral fields.
- Code files should remain a few hundred lines long. A larger file indicates a missing module boundary or abstraction.

- The parity bar is specification compliance to the point of untrained-human indistinguishability from a correct render. Raw differences remain evidence; configuration-controlled optimizations may trade only imperceptible precision.
- Paged CSS compliance is the target. Do not assume an oracle is correct: check disputed behavior against the applicable standard and repair or regenerate an incorrect reference.
- Future oracle PDFs must be generated only by the pinned Chromium Fontations/Foundation launcher. Authenticated historical non-Chromium references may remain as evidence, but must never be regenerated or used as the source of a new oracle.
- Candidate and oracle PDFs use the same pinned `pdf2ppm`/`pdftoppm` executable and arguments. A raster difference means the PDFs differ; do not attribute it to different rasterizers.
- Never translate, register, jitter, crop, resize, filter, resample, or replace either comparison raster. Diffs must show the complete page canvas without copying source content into the diff.
- A per-pixel RGB channel delta below 1% is semantically correct, while the exact RGBA mismatch remains reported. A complete page may contain at most 1% above-floor pixels; authored-scale defects can still fail below that aggregate ceiling.
- Pin UA behavior explicitly in oracle fixtures. If a fixture or pinned UA change affects oracle paint, regenerate the affected PDF references and `refs.lock` before publishing a report.
- Keep `tests/parity/reports/index.html`, `tests/parity/REPORT.md`, and `tests/parity/report.json` current after retained renderer or comparator changes.
- Fix shared problem families, starting with the largest human-visible differences. Verify visually similar failures before weakening a global guard.
- Prefer proper module hierarchies over flat files or compatibility scaffolding. Do not use `#[path = "..."]` to simulate a module hierarchy.
