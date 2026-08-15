# Compatibility Corpus

`manifest.json` accounts for every external corpus file. Do not add an ebook
unless redistribution and repository storage are permitted by its license.

Each entry records:

- a stable ID and repository-relative file path;
- source URL or synthetic provenance;
- license and redistribution statement;
- SHA-256 digest;
- behavior tags;
- expected `converted` or `rejected` outcome.

Run `bun run --filter '@takio/epub-transform' corpus:verify` to verify provenance
fields, file digests, and expected transformation outcomes. Private or locally
downloaded test books belong in an ignored external corpus and should use a
separate manifest supplied to future tooling, not be committed here.

