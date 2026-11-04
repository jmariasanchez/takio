//! Streaming SHA-256 fingerprints shared by every module that verifies bytes.
//!
//! Every owned-file operation in Takio records a byte count and a SHA-256
//! digest. The helpers here keep one implementation of that streaming loop so
//! callers only decide how to map an I/O failure to their own stable error
//! code.

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Chunk size used for streaming reads.
const CHUNK_BYTES: usize = 64 * 1024;

pub(crate) fn write_new_file(path: &Path, bytes: &[u8]) -> crate::error::AppResult<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// A byte count paired with the lowercase hexadecimal SHA-256 digest of those
/// bytes. Serialization retains the historical `[bytes, sha256]` representation.
#[derive(Clone, Debug, Eq, PartialEq, Hash, Ord, PartialOrd, Deserialize, Serialize)]
#[serde(from = "(u64, String)", into = "(u64, String)")]
pub struct Fingerprint {
    pub bytes: u64,
    pub sha256: String,
}

impl From<(u64, String)> for Fingerprint {
    fn from((bytes, sha256): (u64, String)) -> Self {
        Self { bytes, sha256 }
    }
}

impl From<Fingerprint> for (u64, String) {
    fn from(value: Fingerprint) -> Self {
        (value.bytes, value.sha256)
    }
}

/// Hash every byte from `reader` until EOF.
///
/// # Errors
///
/// Returns the underlying I/O error when the reader fails.
pub fn hash_reader<R: Read + ?Sized>(reader: &mut R) -> io::Result<Fingerprint> {
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok(Fingerprint {
        bytes,
        sha256: hex::encode(hash.finalize()),
    })
}

/// Open `path` and hash its complete contents.
pub fn hash_file(path: &Path) -> io::Result<Fingerprint> {
    hash_reader(&mut File::open(path)?)
}

/// Copy every byte from `reader` to `writer` while hashing the stream.
///
/// The writer is not flushed or synced; callers that publish durable files
/// must call `sync_all` themselves so the failure mapping stays explicit.
///
/// # Errors
///
/// Returns [`CopyError::Read`] when the source fails and [`CopyError::Write`]
/// when the destination fails, so callers can report distinct stable codes.
pub fn copy_and_hash<R: Read + ?Sized, W: Write + ?Sized>(
    reader: &mut R,
    writer: &mut W,
) -> Result<Fingerprint, CopyError> {
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    loop {
        let read = reader.read(&mut buffer).map_err(CopyError::Read)?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(CopyError::Write)?;
        hash.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok(Fingerprint {
        bytes,
        sha256: hex::encode(hash.finalize()),
    })
}

/// Distinguishes which side of a streaming copy failed.
#[derive(Debug)]
pub enum CopyError {
    Read(io::Error),
    Write(io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_fingerprint_preserves_tuple_wire_format() {
        let fingerprint = Fingerprint {
            bytes: 3,
            sha256: "abc".into(),
        };
        let wire = serde_json::json!([3, "abc"]);
        assert_eq!(serde_json::to_value(&fingerprint).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<Fingerprint>(wire).unwrap(),
            fingerprint
        );
    }
    use std::io::Cursor;

    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn hashes_empty_input() {
        let Fingerprint {
            bytes,
            sha256: digest,
        } = hash_reader(&mut Cursor::new(Vec::<u8>::new())).unwrap();
        assert_eq!(bytes, 0);
        assert_eq!(digest, EMPTY_SHA256);
    }

    #[test]
    fn hashes_known_vector() {
        let Fingerprint {
            bytes,
            sha256: digest,
        } = hash_reader(&mut Cursor::new(b"abc".to_vec())).unwrap();
        assert_eq!(bytes, 3);
        assert_eq!(digest, ABC_SHA256);
    }

    #[test]
    fn hashes_inputs_larger_than_one_chunk() {
        let payload = vec![0x5au8; CHUNK_BYTES * 3 + 17];
        let Fingerprint {
            bytes,
            sha256: digest,
        } = hash_reader(&mut Cursor::new(payload.clone())).unwrap();
        assert_eq!(bytes as usize, payload.len());
        assert_eq!(digest, hex::encode(Sha256::digest(&payload)));
    }

    #[test]
    fn hash_file_matches_reader() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sample.bin");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            hash_file(&path).unwrap(),
            Fingerprint {
                bytes: 3,
                sha256: ABC_SHA256.to_owned()
            }
        );
    }

    #[test]
    fn hash_file_reports_missing_file() {
        let temp = tempfile::tempdir().unwrap();
        assert!(hash_file(&temp.path().join("missing")).is_err());
    }

    #[test]
    fn copy_and_hash_streams_every_byte() {
        let payload = vec![0x17u8; CHUNK_BYTES + 1];
        let mut output = Vec::new();
        let Fingerprint {
            bytes,
            sha256: digest,
        } = copy_and_hash(&mut Cursor::new(payload.clone()), &mut output).unwrap();
        assert_eq!(output, payload);
        assert_eq!(bytes as usize, payload.len());
        assert_eq!(digest, hex::encode(Sha256::digest(&payload)));
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("disk full"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn copy_and_hash_distinguishes_write_failures() {
        let error =
            copy_and_hash(&mut Cursor::new(b"abc".to_vec()), &mut FailingWriter).unwrap_err();
        assert!(matches!(error, CopyError::Write(_)));
    }

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("unplugged"))
        }
    }

    #[test]
    fn copy_and_hash_distinguishes_read_failures() {
        let error = copy_and_hash(&mut FailingReader, &mut Vec::new()).unwrap_err();
        assert!(matches!(error, CopyError::Read(_)));
    }
}
