//! Copyable stale-reply tokens shared by query, reader and review flows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Generation(u64);

impl Generation {
    pub(super) fn advance(&mut self) -> Self {
        self.0 = self.0.wrapping_add(1);
        *self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advancing_invalidates_the_previous_token() {
        let mut generation = Generation::default();
        let previous = generation;
        let current = generation.advance();
        assert_ne!(previous, current);
        assert_eq!(generation, current);
    }
}
