# Takio Domain Glossary

## Library

A local catalogue and its associated Takio-owned files. A named library is an
independent Library, not a filtered view of another Library.

## Book

The logical work a person browses, edits, converts, reads, and sends. A Book can
have multiple Format Attachments and one set of library metadata.

## Format Attachment

One concrete ebook representation attached to a Book, such as EPUB, PDF, or
AZW3. A Format Attachment is either Managed or Referenced.

## Managed Format

A Format Attachment whose bytes Takio owns and may replace or delete through an
explicit library operation.

## Referenced Format

A Format Attachment whose bytes remain owned by the caller. Takio may detach the
reference but must not delete the file.

## Duplicate Candidate

A canonically ordered pair of active Books with one or more conservative
Duplicate Signals. It is a request for human review, not a declaration that the
Books must be merged.

## Duplicate Signal

Evidence that contributes to a Duplicate Candidate, currently same content,
same identifier, or the same normalized title and author.

## Duplicate Review

A human decision to keep both Books separate, reopen the pair for review, or
merge one Book into the other. A review applies only while its Review Token is
current.

## Review Token

A stable digest of the current Duplicate Candidate. A changed token means the
Books or their evidence changed and the previous decision must not be applied.

## Book Merge

An explicit operation that keeps one target Book, optionally transfers selected
formats and cover state from a source Book, applies reviewed metadata, and then
removes the source Book atomically.

## Metadata Candidate

A proposed set of Book metadata with provenance. A Metadata Candidate never
changes a Book until a person or explicit automation policy applies selected
fields.

## Virtual Library

A named, persistent query and presentation over one Library. It does not own or
copy Books.

## Reader Device

A physical or logical destination that can receive and possibly inventory Books.
Its identity is stable across transient mount paths or network addresses.

## Device Transport

The mechanism used to communicate with a Reader Device, such as mass storage,
MTP, SSH, local network, or email delivery.

## Device Capability

A discovered or configured fact about a Reader Device, including supported
formats, available space, collections, inventory, and transfer behavior.

## Reading Progress

A user's durable position in a particular Book. Reading Progress belongs to a
reader identity and must remain separate from descriptive Book metadata.

## Annotation

A highlight, note, or bookmark anchored to a Book location. An Annotation can
become orphaned when content changes and must retain enough evidence for manual
recovery.

## Recipe

A versioned declaration of a bounded multi-step Takio workflow. A Recipe can use
only registered Operations and cannot execute arbitrary shell commands.

## Operation

A typed Takio capability available to a Recipe. An Operation declares its input,
output, side effects, retry safety, required capabilities, and resource limits.

## Recipe Run

One durable execution of a Recipe, including the state and outcomes of every
step. A Recipe Run can be canceled or resumed according to each Operation's
retry contract.

## Content Service

Takio's authenticated HTTP surface for catalogue access, format delivery, and
later browser reading. Local and remote deployment modes share the same library
rules but have different identity and security requirements.
