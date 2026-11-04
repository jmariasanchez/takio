//! Library-query adapter for the shared native text input.
use super::text_input::TextInput;
use crate::state::LibraryEntity;
use gpui::Context;

pub fn new(state: LibraryEntity, cx: &mut Context<TextInput>) -> TextInput {
    let mut input = TextInput::new(state.read(cx).query.clone(), cx);
    input.set_label("Search library");
    input.set_placeholder("Search");
    input.key_context = "TextInput Search";
    let guard = state.clone();
    input.read_only_when = Some(Box::new(move |cx| guard.read(cx).switching_library()));
    input.on_change = Some(Box::new(move |text, cx| {
        state.update(cx, |state, cx| state.set_query(text.to_owned(), cx));
    }));
    input
}
