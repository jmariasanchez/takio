//! Library-scoped view data. Replaced as one value after successful activation.
use super::*;

pub struct LibrarySession {
    pub section: Section,
    pub items: Vec<Arc<LibraryItem>>,
    pub facets: Arc<Facets>,
    pub selected: BTreeSet<usize>,
    pub anchor: Option<usize>,
    pub query: String,
    pub filters: Filters,
    pub sort: Sort,
    pub loading: bool,
    pub status: Option<Status>,
    pub reader_shelves: crate::engine::ReaderShelves,
    pub on_reader: HashMap<String, Vec<String>>,
    pub reading: HashMap<String, (String, takio::delivery::koreader::ReadingState)>,
    pub scanning_readers: bool,
    pub destination_error: Option<AppError>,
    pub delivery_exclusions: Vec<SendPreviewEntry>,
    pub automatic_backup_prompt_open: bool,
    pub recovery_outcome: Option<RecoveryOutcome>,
    pub(super) activity: Activity,
    pub metadata_editing: bool,
    pub metadata_save_result: Option<AppResult<String>>,
    pub delivery_report: Option<SendReport>,
    pub(super) sorting: bool,
    pub(super) debounce: Option<PendingQuery>,
}

impl Default for LibrarySession {
    fn default() -> Self {
        Self {
            section: Section::Library,
            items: Vec::new(),
            facets: Arc::new(Facets::default()),
            selected: BTreeSet::new(),
            anchor: None,
            query: String::new(),
            filters: Filters::default(),
            sort: Sort::default(),
            loading: false,
            status: None,
            reader_shelves: Vec::new(),
            on_reader: HashMap::new(),
            reading: HashMap::new(),
            scanning_readers: false,
            destination_error: None,
            delivery_exclusions: Vec::new(),
            automatic_backup_prompt_open: false,
            recovery_outcome: None,
            activity: Activity::Idle,
            metadata_editing: false,
            metadata_save_result: None,
            delivery_report: None,
            sorting: false,
            debounce: None,
        }
    }
}
