//! UI-owned activation reporting. Call persistence only on a background worker.
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreferenceOutcome {
    Saved,
    SessionOnly,
    NotRequested,
}

#[derive(Debug)]
pub struct ActivationReport {
    pub root: PathBuf,
    pub preference: PreferenceOutcome,
    pub warning: Option<String>,
}

impl ActivationReport {
    pub fn startup(root: PathBuf, warning: Option<String>) -> Self {
        Self {
            root,
            preference: PreferenceOutcome::NotRequested,
            warning,
        }
    }

    pub fn remember(root: PathBuf, preference: Option<&Path>) -> Self {
        let preference = match preference {
            None => PreferenceOutcome::NotRequested,
            Some(path) if crate::preferences::save(path, &root).is_ok() => PreferenceOutcome::Saved,
            Some(_) => PreferenceOutcome::SessionOnly,
        };
        let warning = (preference == PreferenceOutcome::SessionOnly).then(||
            "Opened this library for this session only, but could not remember its location. The previous library was not replaced. Check the profile folder permissions.".into());
        Self {
            root,
            preference,
            warning,
        }
    }

    pub fn message(&self) -> (String, bool) {
        if let Some(warning) = &self.warning {
            return (warning.clone(), true);
        }
        let suffix = match self.preference {
            PreferenceOutcome::Saved => " This library will reopen next time.",
            PreferenceOutcome::NotRequested => {
                " Session only: the startup preference is unchanged."
            }
            PreferenceOutcome::SessionOnly => {
                " Session only: the startup preference could not be saved."
            }
        };
        (
            format!("Opened {}.{suffix}", self.root.display()),
            self.preference == PreferenceOutcome::SessionOnly,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_reports_saved_session_only_and_not_requested() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("preference");
        let saved = ActivationReport::remember(root.clone(), Some(&path));
        assert_eq!(saved.preference, PreferenceOutcome::Saved);
        assert_eq!(crate::preferences::load(&path).unwrap(), Some(root.clone()));
        let failed = ActivationReport::remember(root.clone(), Some(&root));
        assert_eq!(failed.preference, PreferenceOutcome::SessionOnly);
        assert!(failed.message().1);
        assert!(failed.message().0.contains("for this session"));
        let untouched = ActivationReport::remember(root.clone(), None);
        assert_eq!(untouched.preference, PreferenceOutcome::NotRequested);
        assert!(!untouched.message().1);
        assert_eq!(crate::preferences::load(&path).unwrap(), Some(root));
    }
}
