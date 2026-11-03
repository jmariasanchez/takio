//! Bounded thumbnails. File IO, decoding, resizing, and BGRA conversion run off-thread.
use std::collections::VecDeque;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gpui::{Context, RenderImage};
use image::{DynamicImage, Frame, ImageDecoder, ImageReader, Limits, imageops::FilterType};

const CAPACITY: usize = 64;
const MAX_EDGE: u32 = 480;
const MAX_INPUT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SOURCE_EDGE: u32 = 16_384;

#[derive(Default)]
pub struct CoverCache {
    entries: VecDeque<(PathBuf, Option<Arc<RenderImage>>)>,
}

impl CoverCache {
    fn lookup(&mut self, path: &Path) -> Option<Option<Arc<RenderImage>>> {
        let index = self.entries.iter().position(|(key, _)| key == path)?;
        let entry = self.entries.remove(index)?;
        let image = entry.1.clone();
        self.entries.push_back(entry);
        Some(image)
    }

    fn insert(&mut self, path: PathBuf, image: Option<Arc<RenderImage>>) {
        self.entries.retain(|(key, _)| key != &path);
        self.entries.push_back((path, image));
        while self.entries.len() > CAPACITY {
            self.entries.pop_front();
        }
    }

    /// `None` includes pending and failed loads, avoiding retry loops on corrupt files.
    /// The inspector owns the shared cache and is notified after the worker finishes.
    pub fn get_or_load<T: 'static>(
        &mut self,
        path: &Path,
        shared: Arc<Mutex<Self>>,
        cx: &mut Context<T>,
    ) -> Option<Arc<RenderImage>> {
        if let Some(image) = self.lookup(path) {
            return image;
        }
        let path = path.to_path_buf();
        self.insert(path.clone(), None);
        let task = cx.background_executor().spawn(async move {
            let image = decode_cover(&path);
            let mut cache = shared.lock().unwrap_or_else(|error| error.into_inner());
            // An evicted load must not evict a more recently requested cover.
            if let Some((_, value)) = cache.entries.iter_mut().find(|(key, _)| key == &path) {
                *value = image;
            }
        });
        cx.spawn(async move |owner, cx| {
            task.await;
            let _ = owner.update(cx, |_, cx| cx.notify());
        })
        .detach();
        None
    }
}

fn decode_cover(path: &Path) -> Option<Arc<RenderImage>> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_INPUT_BYTES {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_INPUT_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return None;
    }
    let format = image::guess_format(&bytes).ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_EDGE);
    limits.max_image_height = Some(MAX_SOURCE_EDGE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(bytes.as_slice()), format);
    reader.limits(limits);
    let decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    // Some codecs only enforce dimension limits. Bound both their output and the
    // later RGBA conversion before allocating either full-sized pixel buffer.
    if decoder.total_bytes() > MAX_DECODE_BYTES
        || u64::from(width) * u64::from(height) * 4 > MAX_DECODE_BYTES
    {
        return None;
    }
    let mut pixels = DynamicImage::from_decoder(decoder).ok()?.into_rgba8();
    let (width, height) = pixels.dimensions();
    let longest = width.max(height);
    if longest > MAX_EDGE {
        let width = (u64::from(width) * u64::from(MAX_EDGE) / u64::from(longest)).max(1) as u32;
        let height = (u64::from(height) * u64::from(MAX_EDGE) / u64::from(longest)).max(1) as u32;
        pixels = image::imageops::resize(&pixels, width, height, FilterType::Triangle);
    }
    // RenderImage expects BGRA, not the image crate's RGBA.
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(vec![Frame::new(pixels)])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_decodes_and_cache_returns_expected_size() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cover.png");
        image::RgbaImage::from_pixel(4, 6, image::Rgba([11, 22, 33, 255]))
            .save(&path)
            .unwrap();
        let image = std::thread::spawn({
            let path = path.clone();
            move || decode_cover(&path).unwrap()
        })
        .join()
        .unwrap();
        let mut cache = CoverCache::default();
        cache.insert(path.clone(), Some(image.clone()));
        let cached = cache.lookup(&path).unwrap().unwrap();
        assert!(Arc::ptr_eq(&image, &cached));
        assert_eq!(cached.size(0), gpui::size(4.into(), 6.into()));
        assert_eq!(&cached.as_bytes(0).unwrap()[..4], &[33, 22, 11, 255]);
    }

    #[test]
    fn cache_evicts_least_recently_used_and_bounds_failures() {
        let mut cache = CoverCache::default();
        for index in 0..CAPACITY {
            cache.insert(PathBuf::from(index.to_string()), None);
        }
        assert!(cache.lookup(Path::new("0")).is_some());
        cache.insert(PathBuf::from("new"), None);
        assert_eq!(cache.entries.len(), CAPACITY);
        assert!(cache.lookup(Path::new("1")).is_none());
        assert!(cache.lookup(Path::new("0")).is_some());
    }

    #[test]
    fn large_cover_is_downscaled_and_invalid_files_are_ignored() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.png");
        image::RgbaImage::new(800, 1200).save(&path).unwrap();
        assert_eq!(
            decode_cover(&path).unwrap().size(0),
            gpui::size(320.into(), 480.into())
        );
        assert!(decode_cover(&directory.path().join("missing.png")).is_none());
        std::fs::write(&path, b"not an image").unwrap();
        assert!(decode_cover(&path).is_none());
    }

    #[test]
    fn cover_formats_are_detected_from_bytes_not_extension() {
        let directory = tempfile::tempdir().unwrap();
        let source = image::RgbImage::from_pixel(4, 6, image::Rgb([11, 22, 33]));
        for format in [
            image::ImageFormat::Png,
            image::ImageFormat::Jpeg,
            image::ImageFormat::Gif,
            image::ImageFormat::WebP,
            image::ImageFormat::Bmp,
            image::ImageFormat::Tiff,
        ] {
            let path = directory.path().join("cover.unknown");
            source.save_with_format(&path, format).unwrap();
            let before = std::fs::read(&path).unwrap();
            let decoded = decode_cover(&path).unwrap_or_else(|| panic!("{format:?}"));
            assert_eq!(decoded.size(0), gpui::size(4.into(), 6.into()));
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn cover_rejects_oversized_input_without_changing_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oversized.png");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_INPUT_BYTES + 1).unwrap();
        assert!(decode_cover(&path).is_none());
        assert_eq!(file.metadata().unwrap().len(), MAX_INPUT_BYTES + 1);
        assert!(decode_cover(directory.path()).is_none());
    }

    #[test]
    fn cover_rejects_dimensions_and_rgba_expansion_over_budget() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("wide.png");
        image::GrayImage::new(MAX_SOURCE_EDGE + 1, 1)
            .save(&path)
            .unwrap();
        assert!(decode_cover(&path).is_none());

        // A valid compressed grayscale image fits both the input and raw decode
        // caps, but its RGBA conversion would exceed the output allocation cap.
        let path = directory.path().join("expanded.png");
        image::GrayImage::new(6000, 6000).save(&path).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() < MAX_INPUT_BYTES);
        assert!(decode_cover(&path).is_none());
    }
}
