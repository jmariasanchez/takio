//! Exclusive foreground work, separate from independent queries and reader scans.
use super::{PreparationPreview, SendPreview};

#[derive(Default)]
pub(super) enum Activity {
    #[default]
    Idle,
    Running(Operation),
    ReviewingSend(SendPreview),
    ReviewingPreparation(PreparationPreview),
    SwitchingLibrary,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Operation {
    Mutation,
    SavingMetadata,
    PreviewingPreparation,
}

impl Activity {
    pub(super) fn take_send_preview(&mut self) -> Option<SendPreview> {
        match std::mem::take(self) {
            Self::ReviewingSend(preview) => Some(preview),
            other => {
                *self = other;
                None
            }
        }
    }

    pub(super) fn take_preparation_preview(&mut self) -> Option<PreparationPreview> {
        match std::mem::take(self) {
            Self::ReviewingPreparation(preview) => Some(preview),
            other => {
                *self = other;
                None
            }
        }
    }
    pub(super) fn is_idle(&self) -> bool {
        matches!(self, Self::Idle)
    }

    pub(super) fn is_running(&self) -> bool {
        matches!(self, Self::Running(_) | Self::SwitchingLibrary)
    }

    pub(super) fn is_operation(&self, operation: Operation) -> bool {
        matches!(self, Self::Running(current) if *current == operation)
    }

    pub(super) fn send_preview(&self) -> Option<&SendPreview> {
        match self {
            Self::ReviewingSend(preview) => Some(preview),
            _ => None,
        }
    }

    pub(super) fn preparation_preview(&self) -> Option<&PreparationPreview> {
        match self {
            Self::ReviewingPreparation(preview) => Some(preview),
            _ => None,
        }
    }
}
