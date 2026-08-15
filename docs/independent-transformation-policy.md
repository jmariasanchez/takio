# Independent Transformation Policy

Takio is distributed under the MIT License. Ebook transformation code included
in this repository must therefore be independently implemented.

## Allowed inputs

- Published format specifications and vendor documentation.
- Files created for Takio's test suite or supplied with permission.
- Black-box interoperability observations from released tools and devices.
- General algorithms and architecture patterns that are not copied expression.
- Permissively licensed dependencies used according to their licenses.

## Prohibited inputs

- Copying source code from Calibre or another incompatibly licensed project.
- Line-by-line or structure-preserving translation of that source code.
- Recreating distinctive implementation details from non-public internals.
- Importing GPL code into generated files, fixtures, comments, or documentation.

Calibre may remain an optional external runtime backend. That integration must
use documented command-line behavior and must not require linking or embedding
Calibre code. New native backends should be compared using structural validity,
rendering behavior, and device interoperability rather than source similarity.

Contributors who have inspected an incompatible implementation may still work
on Takio, but should derive code from the allowed inputs above and document the
specification or behavior covered by each non-trivial transformation.
