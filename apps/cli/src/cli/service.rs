use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ColumnLabelRequest {
    key: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ColumnKeyRequest {
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum SourceKind {
    Copy,
    Reference,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FormatSource {
    path: PathBuf,
    kind: SourceKind,
}

impl FormatSource {
    fn provenance(&self) -> takio::library::model::Provenance {
        match self.kind {
            SourceKind::Copy => takio::library::model::Provenance::Managed,
            SourceKind::Reference => takio::library::model::Provenance::Referenced,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AttachFormatRequest {
    #[serde(deserialize_with = "nonempty_item_id")]
    id: String,
    source: FormatSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReplaceFormatRequest {
    #[serde(deserialize_with = "nonempty_item_id")]
    id: String,
    format: FormatId,
    expected_current: takio::library::store::ExpectedFormatSnapshot,
    source: FormatSource,
}

pub(super) fn decode_request<T: DeserializeOwned>(value: &Value) -> AppResult<T> {
    serde_json::from_value(value.clone()).map_err(|_| takio::app_error!("invalid-arguments"))
}

pub(super) fn encode_response(value: impl serde::Serialize) -> AppResult<Value> {
    serde_json::to_value(value).map_err(|_| takio::app_error!("storage-unavailable"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ItemIdRequest {
    #[serde(deserialize_with = "nonempty_item_id")]
    id: String,
}

fn nonempty_item_id<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let id = String::deserialize(deserializer)?;
    if id.trim().is_empty() {
        return Err(serde::de::Error::custom("item id must not be empty"));
    }
    Ok(id)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateRequest {
    #[serde(deserialize_with = "nonempty_item_id")]
    pub(super) id: String,
    pub(super) patch: LibraryPatch,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RemoveFormatRequest {
    #[serde(deserialize_with = "nonempty_item_id")]
    id: String,
    format: FormatId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CoverSetRequest {
    #[serde(deserialize_with = "nonempty_item_id")]
    id: String,
    source_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}

#[derive(Deserialize)]
#[serde(tag = "command", content = "args", rename_all = "snake_case")]
enum Operation {
    #[serde(rename = "library_custom_columns_list")]
    CustomColumnsList(EmptyRequest),
    #[serde(rename = "library_custom_columns_create")]
    CustomColumnsCreate(ColumnLabelRequest),
    #[serde(rename = "library_custom_columns_rename")]
    CustomColumnsRename(ColumnLabelRequest),
    #[serde(rename = "library_custom_columns_remove")]
    CustomColumnsRemove(ColumnKeyRequest),
    #[serde(rename = "library_duplicates_list")]
    DuplicatesList(ListDuplicateCandidatesRequest),
    #[serde(rename = "library_duplicates_keep")]
    DuplicatesKeep(DuplicatePairReviewRequest),
    #[serde(rename = "library_duplicates_reopen")]
    DuplicatesReopen(DuplicatePairReviewRequest),
    #[serde(rename = "library_duplicates_merge")]
    DuplicatesMerge(MergeDuplicatePairRequest),
    #[serde(rename = "library_update")]
    Update(UpdateRequest),
    #[serde(rename = "library_attach_format")]
    AttachFormat(AttachFormatRequest),
    #[serde(rename = "library_remove_format")]
    RemoveFormat(RemoveFormatRequest),
    #[serde(rename = "library_replace_format")]
    ReplaceFormat(ReplaceFormatRequest),
    #[serde(rename = "library_cover_set")]
    CoverSet(CoverSetRequest),
    #[serde(rename = "library_cover_remove")]
    CoverRemove(ItemIdRequest),
    #[serde(rename = "library_trash")]
    Trash(ItemIdRequest),
    #[serde(rename = "library_restore")]
    Restore(ItemIdRequest),
    #[serde(rename = "library_purge")]
    Purge(ItemIdRequest),
}

impl Operation {
    fn execute(self, store: &mut LibraryStore) -> AppResult<Value> {
        match self {
            Self::CustomColumnsList(_) => custom_columns_list(store),
            Self::CustomColumnsCreate(request) => encode_response(
                store.create_custom_column_definition(&request.key, &request.label)?,
            ),
            Self::CustomColumnsRename(request) => encode_response(
                store.rename_custom_column_definition(&request.key, &request.label)?,
            ),
            Self::CustomColumnsRemove(request) => {
                encode_response(store.remove_custom_column_definition(&request.key)?)
            }
            Self::DuplicatesList(request) => duplicates_list(store, &request),
            Self::DuplicatesKeep(request) => {
                store.keep_duplicate_pair(&request)?;
                Ok(Value::Null)
            }
            Self::DuplicatesReopen(request) => {
                store.reopen_duplicate_pair(&request)?;
                Ok(Value::Null)
            }
            Self::DuplicatesMerge(request) => {
                encode_response(store.merge_duplicate_pair(&request)?)
            }
            Self::Update(request) => Ok(json!({"item":update_item(store, request)?})),
            Self::AttachFormat(request) => Ok(
                json!({"item":store.attach_format(&request.id, &request.source.path, request.source.provenance())?}),
            ),
            Self::RemoveFormat(request) => {
                encode_response(store.remove_format(&request.id, request.format)?)
            }
            Self::ReplaceFormat(request) => encode_response(store.replace_format(
                &request.id,
                request.format,
                &request.expected_current,
                &request.source.path,
                request.source.provenance(),
            )?),
            Self::CoverSet(request) => {
                encode_response(store.set_cover(&request.id, &request.source_path)?)
            }
            Self::CoverRemove(request) => encode_response(store.remove_cover(&request.id)?),
            Self::Trash(request) => Ok(json!({"item":store.trash(&request.id)?})),
            Self::Restore(request) => Ok(json!({"item":store.restore(&request.id)?})),
            Self::Purge(request) => encode_response(store.purge(&request.id)?),
        }
    }
}

pub(super) fn update_item(
    store: &mut LibraryStore,
    request: UpdateRequest,
) -> AppResult<takio::library::model::LibraryItem> {
    store.update(&request.id, request.patch)
}

pub(super) fn read_store(
    library: Option<&str>,
    database: Option<&Path>,
) -> AppResult<takio::library::store::ReadOnlyLibraryStore> {
    LibraryStore::open_read_only(LibraryPaths::resolve(library, database)?)
}

pub(super) fn write_store(
    library: Option<&str>,
    database: Option<&Path>,
) -> AppResult<LibraryStore> {
    LibraryStore::create_or_migrate(LibraryPaths::resolve(library, database)?)
}

fn run_operation(
    library: Option<&str>,
    database: Option<&Path>,
    command: &str,
    args: &Value,
) -> AppResult<Value> {
    // Decode before opening a writable library so invalid requests have no filesystem effects.
    let operation: Operation = decode_request(&json!({"command":command,"args":args}))?;
    match operation {
        Operation::CustomColumnsList(_) => custom_columns_list(&*read_store(library, database)?),
        Operation::DuplicatesList(request) => {
            duplicates_list(&*read_store(library, database)?, &request)
        }
        operation => operation.execute(&mut write_store(library, database)?),
    }
}

/// The one-shot CLI's stable JSON envelopes for operations whose service
/// response shape differs. All CLI-only wire adaptations are listed here so
/// command handlers share one dispatch path through `run_cli_operation`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CliEnvelope {
    /// Service response printed unchanged.
    Direct,
    /// Service response wrapped under a named key, for example `definitions`.
    Wrapped(&'static str),
    /// `library remove` keeps its historical trash envelope: trash never leaves
    /// cleanup pending, so these fields are always false and empty.
    TrashWithoutCleanup,
}

impl CliEnvelope {
    pub(super) fn apply(self, value: Value) -> Value {
        match self {
            Self::Direct => value,
            Self::Wrapped(key) => json!({ key: value }),
            Self::TrashWithoutCleanup => {
                let mut value = value;
                value["cleanupPending"] = json!(false);
                value["cleanupPendingPaths"] = json!([]);
                value
            }
        }
    }
}

pub(super) fn run_cli_operation(
    library: Option<&str>,
    database: Option<&Path>,
    command: &str,
    args: &Value,
    envelope: CliEnvelope,
) -> AppResult<Value> {
    run_operation(library, database, command, args).map(|value| envelope.apply(value))
}

fn custom_columns_list(store: &LibraryStore) -> AppResult<Value> {
    encode_response(store.list_custom_column_definitions()?)
}

fn duplicates_list(
    store: &LibraryStore,
    request: &ListDuplicateCandidatesRequest,
) -> AppResult<Value> {
    encode_response(store.list_duplicate_candidates(request)?)
}

pub(super) fn library_service(library: Option<&str>, database: Option<&Path>) -> AppResult<()> {
    let mut store = write_store(library, database)?;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let mut line = String::new();
    loop {
        line.clear();
        let read = input
            .read_line(&mut line)
            .map_err(|_| takio::app_error!("storage-unavailable"))?;
        if read == 0 {
            return Ok(());
        }
        let request = serde_json::from_str::<Value>(line.trim_end());
        let (id, result) = match request {
            Ok(request) => {
                let id = request
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let result = service_request(&mut store, &request);
                (id, result)
            }
            Err(_) => (String::new(), Err(takio::app_error!("invalid-arguments"))),
        };
        let mut response = match result {
            Ok(value) => crate::output::success(value),
            Err(error) => crate::output::failure(error.kind()),
        };
        response["id"] = json!(id);
        writeln!(output, "{response}").map_err(|_| takio::app_error!("terminal-unavailable"))?;
        output
            .flush()
            .map_err(|_| takio::app_error!("terminal-unavailable"))?;
    }
}

pub(super) fn service_request(store: &mut LibraryStore, request: &Value) -> AppResult<Value> {
    decode_request::<Operation>(request)?.execute(store)
}

#[cfg(test)]
mod tests {
    use super::CliEnvelope;
    use serde_json::json;

    #[test]
    fn cli_envelopes_are_the_only_wire_adaptations() {
        let value = json!({"item":{"id":"a"}});
        assert_eq!(CliEnvelope::Direct.apply(value.clone()), value);
        assert_eq!(
            CliEnvelope::Wrapped("definitions").apply(json!([1])),
            json!({"definitions":[1]})
        );
        assert_eq!(
            CliEnvelope::TrashWithoutCleanup.apply(value),
            json!({"item":{"id":"a"},"cleanupPending":false,"cleanupPendingPaths":[]})
        );
    }
}
