# Compatibility Contract

## Supported now

- Unencrypted, reflowable EPUB ZIP containers.
- A valid `mimetype` entry and `META-INF/container.xml` rootfile declaration.
- EPUB package manifests whose spine resolves HTML or XHTML content documents.
- Relative, contained manifest paths.
- Kobo location-span insertion while preserving non-spine resources.
- EPUB 2 cover metadata normalization to the EPUB 3 `cover-image` property.

## Rejected now

- Missing or malformed container/package/spine graphs.
- Absolute, backslash, traversing, duplicate, or malformed archive paths.
- ZIP64 and archives outside configured entry or byte limits.
- Empty EPUBs and spines without HTML/XHTML content.
- Invalid percent-encoded manifest references.

## Not yet claimed

- Fixed-layout EPUB and KEPUB behavior.
- Encrypted resources or DRM.
- Repair of malformed XML/HTML.
- Complete EPUB 2 and EPUB 3 namespace variation support.
- Guaranteed typography, footnote, RTL, vertical-text, SVG, or MathML behavior.
- Byte-deterministic output across separate executions.
- Real-device annotation and resume compatibility.

Claims move from "not yet claimed" only with corpus evidence and, for behavioral
Kobo features, a recorded real-device run.

