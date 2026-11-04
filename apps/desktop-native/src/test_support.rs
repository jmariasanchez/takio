//! Bounded waits for real engine threads used by native test harnesses.
use std::time::{Duration, Instant};

#[cfg(test)]
use crate::state::LibraryEntity;
use crate::state::LibraryState;
#[cfg(test)]
use gpui::TestAppContext;

pub fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if ready() {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub fn is_settled(state: &LibraryState) -> bool {
    !(state.session().loading
        || state.busy()
        || state.refreshing_destinations()
        || state.session().scanning_readers)
}

#[cfg(test)]
pub fn settle(state: &LibraryEntity, cx: &mut TestAppContext) {
    wait_until("library state to settle", || {
        cx.run_until_parked();
        state.read_with(cx, |state, _| is_settled(state))
    });
}
