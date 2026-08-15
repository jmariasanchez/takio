# `@takio/epub-transform`

Independent, MIT-licensed EPUB transformations for Takio.

The first backend converts reflowable EPUB files into Kobo-compatible KEPUB
containers. It discovers the package through the EPUB OCF container, follows
the OPF spine, adds Kobo location spans to spine content, normalizes the EPUB 3
cover-image property, preserves other resources, and publishes a fresh EPUB ZIP.

The implementation is based on the W3C EPUB specification, public Kobo EPUB
guidance, black-box device behavior, and interoperability behavior documented by
the MIT-licensed `pgaskin/kepubify` project. It does not copy or translate
Calibre source code.

Current exclusions include DRM, fixed-layout KEPUB, typography rewriting,
hyphenation dictionaries, and repair of malformed HTML/XML. Invalid or unsafe
containers fail closed instead of being repaired implicitly.
