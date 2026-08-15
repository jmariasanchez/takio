# Native EPUB Transformation Map

## Destination

Takio owns a production-grade EPUB substrate: EPUB-to-KEPUB produces structurally
valid, device-proven output across a provenance-tracked corpus, and EPUB metadata
read/write no longer requires Calibre.

## Scope

Included:

- Reflowable EPUB 2 and EPUB 3 input.
- Native KEPUB transformation, validation, and Kobo interoperability.
- Native EPUB package metadata and cover extraction/materialization.
- CLI, queue, desktop, and delivery behavior that uses those capabilities.

Excluded from this map:

- DRM removal or conversion.
- PDF, AZW3, MOBI, DOCX, and general HTML conversion engines.
- Ebook reading, editing, or plugin hosting.
- Fixed-layout KEPUB production. Fixed-layout input is detected and rejected
  truthfully until a separate map accepts it.

## Operating tactics

1. **Corpus before cleverness.** Every parser or transformation change lands with
   a synthetic regression and, where licensing permits, a corpus case.
2. **Specifications define validity.** W3C EPUB/OCF and public Kobo behavior are
   authoritative. Permissive projects can inform interoperability, never copied
   structure for its own sake.
3. **Differential tests are evidence, not the contract.** Compare with permissive
   reference tooling and Calibre black-box output, but do not require byte parity.
4. **Fail closed, report precisely.** Unsafe containers, DRM, unsupported layout,
   malformed package graphs, and resource limits receive distinct stable errors.
5. **One vertical slice at a time.** Package API, CLI, queue, compiled binary, and
   device delivery are validated together before moving to another behavior.
6. **No device claim without a device run.** Structural tests cannot certify
   annotation, resume, navigation, or rendering behavior.

## Milestone 1: Compatibility contract and corpus

- Publish supported and rejected input profiles.
- Maintain a manifest with source, license, digest, tags, and expected outcome.
- Reach at least 100 legally usable cases across EPUB 2/3, navigation, footnotes,
  RTL, vertical text, SVG, MathML, fonts, images, long chapters, and malformed
  containers.
- Add generated boundary cases for traversal, ZIP bombs, duplicate paths, broken
  manifests, namespace variants, quoted markup, and cancellation.
- Produce a machine-readable corpus report in CI.

Exit gate: every case is accounted for, no corrupt output is published, and the
corpus can be reproduced from documented sources.

## Milestone 2: Parser and publication hardening

- Replace regex-based package interpretation with bounded namespace-aware XML.
- Replace markup token heuristics with an XML/HTML-aware streaming transform.
- Preserve comments, CDATA, entities, namespaces, and inline semantics.
- Make ZIP output deterministic and validate `mimetype` placement/compression.
- Add explicit fixed-layout, encryption, resource-limit, and malformed-graph
  error codes.

Exit gate: repeated conversion is byte deterministic, every corpus output passes
structural validation, and malformed inputs fail without partial publication.

## Milestone 3: Kobo interoperability proof

- Compare structural behavior with `kepubify` and black-box Calibre output.
- Run EPUBCheck-compatible validation where it applies to the resulting EPUB.
- Test sideloaded `.kepub.epub` files on a real Kobo for TOC navigation, reading
  position, annotations, search, footnotes, RTL, SVG, MathML, and long chapters.
- Record device model, firmware, input digest, output digest, and observations.

Exit gate: the real-device matrix passes with no data-loss or navigation defects.

## Milestone 4: Native EPUB metadata

- Read title, authors, identifiers, language, dates, series, description, tags,
  and cover from EPUB 2/3 packages.
- Materialize current Takio metadata only into temporary delivery copies.
- Preserve source bytes and atomically reject malformed or unsupported writes.
- Prefer the native metadata backend for EPUB/KEPUB import, export, and send.

Exit gate: EPUB import and delivery metadata work with all Calibre executables
absent, while non-EPUB formats continue to report their external dependency.

## Release gates

- At least 100 provenance-tracked corpus cases with zero unaccounted outcomes.
- Zero structurally corrupt published artifacts.
- Deterministic output for identical input and settings.
- Full repository checks, tests, builds, and compiled-binary smoke tests pass.
- Real Kobo annotation/resume/navigation matrix passes.
- No copied or translated GPL implementation code.

## Current frontier

1. Fill the corpus manifest with synthetic and redistributable cases.
2. Add namespace-aware package parsing behind the current package API.
3. Define stable native transformation error codes at the CLI boundary.

