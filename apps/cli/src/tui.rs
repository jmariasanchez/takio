use std::collections::BTreeSet;
use std::io::{self, Stdout};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Tabs, Wrap};
use serde_json::Value;

use crate::cli::{
    apply_prepared_metadata_candidate, metadata_candidates_for_item, prepare_metadata_candidate,
};
use crate::destinations;
use crate::jobs::JobStore;
use crate::model::LibraryItem;
use crate::output::{AppError, AppResult};
use crate::paths::LibraryPaths;
use crate::store::LibraryStore;

const ACCENT: Color = Color::Rgb(70, 210, 170);
const ACCENT_2: Color = Color::Rgb(120, 150, 255);
const MUTED: Color = Color::Rgb(125, 135, 150);
const PANEL: Color = Color::Rgb(20, 24, 31);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Tab {
    Library,
    Jobs,
    Devices,
    Help,
}

impl Tab {
    const ALL: [Self; 4] = [Self::Library, Self::Jobs, Self::Devices, Self::Help];
    const fn title(self) -> &'static str {
        match self {
            Self::Library => "Library",
            Self::Jobs => "Jobs",
            Self::Devices => "Devices",
            Self::Help => "Help",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Normal,
    Search,
    Import,
    Palette,
    ConfirmTrash,
    CandidateReview,
    ConfirmCandidate,
}

impl Mode {
    const fn input_title(self) -> &'static str {
        match self {
            Self::Search => "Search library",
            Self::Import => "Import a book",
            Self::Palette => "Run a command",
            Self::Normal | Self::ConfirmTrash | Self::CandidateReview | Self::ConfirmCandidate => {
                "Input"
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CandidateFocus {
    Candidates,
    Fields,
}

struct CandidateReview {
    item_id: String,
    item_title: String,
    candidates: Vec<Value>,
    selected_candidate: usize,
    fields: Vec<String>,
    selected_field: usize,
    selected_fields: BTreeSet<String>,
    focus: CandidateFocus,
    include_online: bool,
    loading: bool,
}

type CandidateLoadResult = (String, Result<Vec<Value>, String>);

struct App {
    paths: LibraryPaths,
    store: LibraryStore,
    items: Vec<LibraryItem>,
    selected: usize,
    tab: Tab,
    mode: Mode,
    input: String,
    query: String,
    status: String,
    should_quit: bool,
    candidate_review: Option<CandidateReview>,
    candidate_rx: Option<Receiver<CandidateLoadResult>>,
}

impl App {
    fn new(paths: LibraryPaths) -> AppResult<Self> {
        let store = LibraryStore::open(paths.clone(), true)?;
        let items = store.list(false)?;
        Ok(Self {
            paths,
            store,
            items,
            selected: 0,
            tab: Tab::Library,
            mode: Mode::Normal,
            input: String::new(),
            query: String::new(),
            status: "Ready".to_owned(),
            should_quit: false,
            candidate_review: None,
            candidate_rx: None,
        })
    }

    fn refresh(&mut self) {
        let result = if self.query.is_empty() {
            self.store.list(false)
        } else {
            self.store.search(&self.query)
        };
        match result {
            Ok(items) => {
                self.items = items;
                self.selected = self.selected.min(self.items.len().saturating_sub(1));
                self.status = format!(
                    "{} book{}",
                    self.items.len(),
                    if self.items.len() == 1 { "" } else { "s" }
                );
            }
            Err(error) => self.status = format!("Error: {}", error.code()),
        }
    }

    fn next(&mut self) {
        if !self.items.is_empty() {
            self.selected = (self.selected + 1).min(self.items.len() - 1);
        }
    }
    fn previous(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }
    fn next_page(&mut self) {
        if !self.items.is_empty() {
            self.selected = (self.selected + 10).min(self.items.len() - 1);
        }
    }
    fn previous_page(&mut self) {
        self.selected = self.selected.saturating_sub(10);
    }
    fn first(&mut self) {
        self.selected = 0;
    }
    fn last(&mut self) {
        self.selected = self.items.len().saturating_sub(1);
    }
    fn selected_item(&self) -> Option<&LibraryItem> {
        self.items.get(self.selected)
    }

    fn submit_input(&mut self) {
        let input = std::mem::take(&mut self.input);
        match self.mode {
            Mode::Search => {
                self.query = input.trim().to_owned();
                self.refresh();
                self.mode = Mode::Normal;
            }
            Mode::Import => {
                let input = input.trim();
                if input.is_empty() {
                    self.status = "Enter a file path to import".to_owned();
                    self.mode = Mode::Normal;
                    return;
                }
                let path = Path::new(input);
                match self.store.import(path, None, false) {
                    Ok(item) => {
                        self.status = format!("Imported {}", item.title);
                        self.query.clear();
                        self.refresh();
                    }
                    Err(error) => self.status = format!("Import failed: {}", error.code()),
                }
                self.mode = Mode::Normal;
            }
            Mode::Palette => {
                let command = input.trim();
                if command.is_empty() {
                    self.status = "No command entered. Press ? to see shortcuts".to_owned();
                } else {
                    self.run_command(command);
                }
                if self.mode == Mode::Palette {
                    self.mode = Mode::Normal;
                }
            }
            Mode::Normal | Mode::ConfirmTrash | Mode::CandidateReview | Mode::ConfirmCandidate => {}
        }
    }

    fn run_command(&mut self, command: &str) {
        let (name, argument) = command
            .split_once(' ')
            .map_or((command, ""), |(name, arg)| (name, arg.trim()));
        match name {
            "q" | "quit" => self.should_quit = true,
            "r" | "refresh" => self.refresh(),
            "search" => {
                self.query = argument.to_owned();
                self.refresh();
            }
            "clear" => {
                self.query.clear();
                self.refresh();
            }
            "import" if !argument.is_empty() => {
                match self.store.import(Path::new(argument), None, false) {
                    Ok(item) => {
                        self.status = format!("Imported {}", item.title);
                        self.refresh();
                    }
                    Err(error) => self.status = format!("Import failed: {}", error.code()),
                }
            }
            "trash" => self.trash_selected(),
            "metadata" | "candidates" => self.begin_candidate_review(false),
            "help" => self.tab = Tab::Help,
            "library" => self.tab = Tab::Library,
            "jobs" => self.tab = Tab::Jobs,
            "devices" => self.tab = Tab::Devices,
            _ => self.status = format!("Unknown command '{name}'. Try help"),
        }
    }

    fn next_tab(&mut self) {
        let index = Tab::ALL
            .iter()
            .position(|tab| *tab == self.tab)
            .unwrap_or(0);
        self.tab = Tab::ALL[(index + 1) % Tab::ALL.len()];
        self.status = format!("{} view", self.tab.title());
    }

    fn previous_tab(&mut self) {
        let index = Tab::ALL
            .iter()
            .position(|tab| *tab == self.tab)
            .unwrap_or(0);
        self.tab = Tab::ALL[(index + Tab::ALL.len() - 1) % Tab::ALL.len()];
        self.status = format!("{} view", self.tab.title());
    }

    fn trash_selected(&mut self) {
        let Some(id) = self.selected_item().map(|item| item.id.clone()) else {
            return;
        };
        match self.store.trash(&id) {
            Ok(item) => {
                self.status = format!("Moved {} to Trash", item.title);
                self.refresh();
            }
            Err(error) => self.status = format!("Trash failed: {}", error.code()),
        }
    }

    fn begin_candidate_review(&mut self, include_online: bool) {
        let Some(item) = self.selected_item().cloned() else {
            self.status = "Select a book to review metadata".to_owned();
            return;
        };
        self.mode = Mode::CandidateReview;
        self.candidate_review = Some(CandidateReview {
            item_id: item.id.clone(),
            item_title: item.title.clone(),
            candidates: Vec::new(),
            selected_candidate: 0,
            fields: Vec::new(),
            selected_field: 0,
            selected_fields: BTreeSet::new(),
            focus: CandidateFocus::Candidates,
            include_online,
            loading: true,
        });
        self.status = if include_online {
            "Looking up local and online metadata...".to_owned()
        } else {
            "Looking for metadata in the filename and ebook...".to_owned()
        };
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = metadata_candidates_for_item(&item, include_online, 15)
                .map_err(|error| error.code().to_owned());
            let _ = tx.send((item.id, result));
        });
        self.candidate_rx = Some(rx);
    }

    fn poll_candidate_loader(&mut self) {
        let Some(receiver) = self.candidate_rx.as_ref() else {
            return;
        };
        let result = match receiver.try_recv() {
            Ok(result) => Some(result),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                Some((String::new(), Err("metadata-unavailable".to_owned())))
            }
        };
        let Some((item_id, result)) = result else {
            return;
        };
        self.candidate_rx = None;
        let Some(review) = self.candidate_review.as_ref() else {
            return;
        };
        if !item_id.is_empty() && review.item_id != item_id {
            return;
        }
        match result {
            Ok(candidates) => self.accept_candidate_results(candidates),
            Err(code) => {
                if let Some(review) = self.candidate_review.as_mut() {
                    review.loading = false;
                }
                self.status = format!("Metadata lookup failed: {code}");
            }
        }
    }

    fn accept_candidate_results(&mut self, candidates: Vec<Value>) {
        let count = candidates.len();
        if let Some(review) = self.candidate_review.as_mut() {
            review.loading = false;
            review.candidates = candidates;
            review.selected_candidate = 0;
            Self::reset_candidate_fields(review);
        }
        self.status = if count == 0 {
            "No metadata suggestions found. Press o for explicit online lookup".to_owned()
        } else {
            format!(
                "Found {count} metadata suggestion{}",
                if count == 1 { "" } else { "s" }
            )
        };
    }

    fn reset_candidate_fields(review: &mut CandidateReview) {
        review.fields = review
            .candidates
            .get(review.selected_candidate)
            .and_then(|candidate| candidate.get("patch"))
            .and_then(Value::as_object)
            .map(|patch| patch.keys().cloned().collect())
            .unwrap_or_default();
        review.selected_field = 0;
        review.selected_fields = review.fields.iter().cloned().collect();
    }

    fn move_candidate(&mut self, delta: isize) {
        let Some(review) = self.candidate_review.as_mut() else {
            return;
        };
        if review.candidates.is_empty() {
            return;
        }
        review.selected_candidate =
            move_index(review.selected_candidate, review.candidates.len(), delta);
        Self::reset_candidate_fields(review);
    }

    fn move_candidate_field(&mut self, delta: isize) {
        let Some(review) = self.candidate_review.as_mut() else {
            return;
        };
        if !review.fields.is_empty() {
            review.selected_field = move_index(review.selected_field, review.fields.len(), delta);
        }
    }

    fn toggle_candidate_field(&mut self) {
        let Some(review) = self.candidate_review.as_mut() else {
            return;
        };
        let Some(field) = review.fields.get(review.selected_field).cloned() else {
            return;
        };
        if !review.selected_fields.remove(&field) {
            review.selected_fields.insert(field);
        }
    }

    fn cancel_candidate_review(&mut self) {
        self.mode = Mode::Normal;
        self.candidate_review = None;
        self.candidate_rx = None;
        self.status = "Metadata review canceled".to_owned();
    }

    fn confirm_candidate(&mut self) {
        let Some(review) = self.candidate_review.as_ref() else {
            return;
        };
        if review.loading {
            self.status = "Wait for metadata lookup to finish".to_owned();
        } else if review.candidates.is_empty() {
            self.status = "No metadata suggestion selected".to_owned();
        } else if review.selected_fields.is_empty() {
            self.status = "Select at least one field to apply".to_owned();
        } else {
            self.mode = Mode::ConfirmCandidate;
        }
    }

    fn apply_candidate(&mut self) {
        let Some(review) = self.candidate_review.as_ref() else {
            return;
        };
        let Some(candidate) = review.candidates.get(review.selected_candidate).cloned() else {
            self.status = "No metadata suggestion selected".to_owned();
            self.mode = Mode::CandidateReview;
            return;
        };
        let item_id = review.item_id.clone();
        let selected_fields = review.selected_fields.clone();
        let result = prepare_metadata_candidate(
            candidate,
            &item_id,
            Some(&selected_fields),
            "tui-candidate-review",
        )
        .and_then(|prepared| {
            let fields = prepared.fields.clone();
            apply_prepared_metadata_candidate(&mut self.store, &item_id, &prepared)
                .map(|item| (item, fields))
        });
        match result {
            Ok((item, fields)) => {
                self.mode = Mode::Normal;
                self.candidate_review = None;
                self.candidate_rx = None;
                self.query.clear();
                self.refresh();
                self.status = format!("Updated {}: {}", item.title, fields.join(", "));
            }
            Err(error) => {
                self.mode = Mode::CandidateReview;
                self.status = format!("Metadata update failed: {}", error.code());
            }
        }
    }

    fn handle_key(&mut self, code: KeyCode, modifiers: KeyModifiers) {
        match self.mode {
            Mode::Search | Mode::Import | Mode::Palette => match code {
                KeyCode::Esc => {
                    self.mode = Mode::Normal;
                    self.input.clear();
                    self.status = "Canceled".to_owned();
                }
                KeyCode::Enter => self.submit_input(),
                KeyCode::Backspace => {
                    self.input.pop();
                }
                KeyCode::Char(character) if !modifiers.contains(KeyModifiers::CONTROL) => {
                    self.input.push(character)
                }
                _ => {}
            },
            Mode::ConfirmTrash => match code {
                KeyCode::Char('y') | KeyCode::Enter => {
                    self.trash_selected();
                    self.mode = Mode::Normal;
                }
                KeyCode::Char('n') | KeyCode::Esc => {
                    self.mode = Mode::Normal;
                    self.status = "Kept in library".to_owned();
                }
                _ => {}
            },
            Mode::CandidateReview => match code {
                KeyCode::Esc => self.cancel_candidate_review(),
                KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => {
                    if let Some(review) = self.candidate_review.as_mut() {
                        review.focus = match review.focus {
                            CandidateFocus::Candidates => CandidateFocus::Fields,
                            CandidateFocus::Fields => CandidateFocus::Candidates,
                        };
                    }
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if matches!(
                        self.candidate_review.as_ref().map(|review| review.focus),
                        Some(CandidateFocus::Fields)
                    ) {
                        self.move_candidate_field(1);
                    } else {
                        self.move_candidate(1);
                    }
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    if matches!(
                        self.candidate_review.as_ref().map(|review| review.focus),
                        Some(CandidateFocus::Fields)
                    ) {
                        self.move_candidate_field(-1);
                    } else {
                        self.move_candidate(-1);
                    }
                }
                KeyCode::Char(' ') => self.toggle_candidate_field(),
                KeyCode::Char('o') => self.begin_candidate_review(true),
                KeyCode::Enter | KeyCode::Char('a') => self.confirm_candidate(),
                _ => {}
            },
            Mode::ConfirmCandidate => match code {
                KeyCode::Char('y') | KeyCode::Enter => self.apply_candidate(),
                KeyCode::Char('n') | KeyCode::Esc => {
                    self.mode = Mode::CandidateReview;
                    self.status = "Reviewing metadata suggestion".to_owned();
                }
                _ => {}
            },
            Mode::Normal => match code {
                KeyCode::Char('q') => self.should_quit = true,
                KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
                    self.should_quit = true
                }
                KeyCode::Down | KeyCode::Char('j') => self.next(),
                KeyCode::Up | KeyCode::Char('k') => self.previous(),
                KeyCode::PageDown => self.next_page(),
                KeyCode::PageUp => self.previous_page(),
                KeyCode::Home | KeyCode::Char('g') => self.first(),
                KeyCode::End | KeyCode::Char('G') => self.last(),
                KeyCode::Right | KeyCode::Tab => self.next_tab(),
                KeyCode::Left | KeyCode::BackTab => self.previous_tab(),
                KeyCode::Char('1') => self.tab = Tab::Library,
                KeyCode::Char('2') => self.tab = Tab::Jobs,
                KeyCode::Char('3') => self.tab = Tab::Devices,
                KeyCode::Char('4') => self.tab = Tab::Help,
                KeyCode::Char('/') => {
                    self.mode = Mode::Search;
                    self.input = self.query.clone();
                }
                KeyCode::Char('i') => {
                    self.mode = Mode::Import;
                    self.input.clear();
                }
                KeyCode::Char(':') => {
                    self.mode = Mode::Palette;
                    self.input.clear();
                }
                KeyCode::Char('d') if self.tab == Tab::Library && !self.items.is_empty() => {
                    self.mode = Mode::ConfirmTrash
                }
                KeyCode::Char('d') if self.tab == Tab::Library => {
                    self.status = "Nothing selected to move to Trash".to_owned()
                }
                KeyCode::Char('m') if self.tab == Tab::Library && !self.items.is_empty() => {
                    self.begin_candidate_review(false)
                }
                KeyCode::Char('m') if self.tab == Tab::Library => {
                    self.status = "Select a book to review metadata".to_owned()
                }
                KeyCode::Char('r') => {
                    self.refresh();
                    self.status = "Library refreshed".to_owned();
                }
                KeyCode::Char('?') => self.tab = Tab::Help,
                KeyCode::Esc if !self.query.is_empty() => {
                    self.query.clear();
                    self.refresh();
                }
                _ => {}
            },
        }
    }
}

struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}
impl TerminalGuard {
    fn enter() -> AppResult<Self> {
        enable_raw_mode().map_err(|_| AppError::new("terminal-unavailable"))?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen)
            .map_err(|_| AppError::new("terminal-unavailable"))?;
        let terminal = Terminal::new(CrosstermBackend::new(stdout))
            .map_err(|_| AppError::new("terminal-unavailable"))?;
        Ok(Self { terminal })
    }
}
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
        let _ = self.terminal.show_cursor();
    }
}

pub fn run(paths: LibraryPaths) -> AppResult<()> {
    let mut app = App::new(paths)?;
    let mut terminal = TerminalGuard::enter()?;
    while !app.should_quit {
        app.poll_candidate_loader();
        terminal
            .terminal
            .draw(|frame| draw(frame, &app))
            .map_err(|_| AppError::new("terminal-unavailable"))?;
        if event::poll(Duration::from_millis(200))
            .map_err(|_| AppError::new("terminal-unavailable"))?
            && let Event::Key(key) =
                event::read().map_err(|_| AppError::new("terminal-unavailable"))?
            && key.kind == KeyEventKind::Press
        {
            app.handle_key(key.code, key.modifiers);
        }
    }
    Ok(())
}

fn draw(frame: &mut ratatui::Frame<'_>, app: &App) {
    let area = frame.area();
    if area.width < 44 || area.height < 14 {
        frame.render_widget(
            Paragraph::new(
                "Takio needs a little more room.\n\nResize to at least 44 x 14, or press q to quit.",
            )
            .alignment(Alignment::Center)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT))
                    .title(" Takio "),
            )
            .wrap(Wrap { trim: true }),
            area,
        );
        return;
    }
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(2),
            Constraint::Min(7),
            Constraint::Length(3),
        ])
        .split(area);
    let brand = Line::from(vec![
        Span::styled(
            " TAKIO ",
            Style::default()
                .fg(Color::Black)
                .bg(ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  your books, close at hand", Style::default().fg(MUTED)),
        Span::styled(
            format!(
                "   {} book{}",
                app.items.len(),
                if app.items.len() == 1 { "" } else { "s" }
            ),
            Style::default().fg(Color::DarkGray),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(brand).block(
            Block::default()
                .borders(Borders::BOTTOM)
                .border_style(Style::default().fg(Color::DarkGray)),
        ),
        vertical[0],
    );
    let titles = Tab::ALL
        .iter()
        .enumerate()
        .map(|(index, tab)| Line::from(format!("{} {}", index + 1, tab.title())))
        .collect::<Vec<_>>();
    let selected = Tab::ALL.iter().position(|tab| *tab == app.tab).unwrap_or(0);
    frame.render_widget(
        Tabs::new(titles)
            .select(selected)
            .style(Style::default().fg(MUTED))
            .highlight_style(
                Style::default()
                    .fg(Color::Black)
                    .bg(ACCENT)
                    .add_modifier(Modifier::BOLD),
            )
            .divider(Span::styled("  ", Style::default().fg(Color::DarkGray)))
            .padding(" ", " "),
        vertical[1],
    );
    match app.tab {
        Tab::Library => draw_library(frame, vertical[2], app),
        Tab::Jobs => draw_jobs(frame, vertical[2], app),
        Tab::Devices => draw_devices(frame, vertical[2]),
        Tab::Help => draw_help(frame, vertical[2]),
    }
    let hint = match (app.mode, app.tab) {
        (Mode::Normal, Tab::Library) => "j/k move  / search  i import  m metadata  d trash",
        (Mode::Normal, Tab::Jobs | Tab::Devices) => "Left/Right switch  r refresh  ? help  q quit",
        (Mode::Normal, Tab::Help) => "1-4 jump to view  Left/Right switch  q quit",
        (Mode::Search, _) => "Enter search  Esc cancel",
        (Mode::Import, _) => "Enter import  Esc cancel",
        (Mode::Palette, _) => "Enter run  Esc cancel",
        (Mode::ConfirmTrash, _) => "Enter/y move  n/Esc keep",
        (Mode::CandidateReview, _) => {
            "Tab pane  j/k move  Space field  o online  Enter review  Esc cancel"
        }
        (Mode::ConfirmCandidate, _) => "Enter/y apply selected fields  n/Esc back",
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                format!(" {} ", app.status),
                Style::default().fg(Color::Black).bg(ACCENT_2),
            ),
            Span::raw("  "),
            Span::styled(hint, Style::default().fg(MUTED)),
        ]))
        .block(
            Block::default()
                .borders(Borders::TOP)
                .border_style(Style::default().fg(Color::DarkGray)),
        ),
        vertical[3],
    );
    match app.mode {
        Mode::Search | Mode::Import | Mode::Palette => draw_input(frame, area, app),
        Mode::ConfirmTrash => draw_confirm(frame, area, app),
        Mode::CandidateReview => draw_candidate_review(frame, area, app),
        Mode::ConfirmCandidate => {
            draw_candidate_review(frame, area, app);
            draw_candidate_confirm(frame, area, app);
        }
        Mode::Normal => {}
    }
}

fn draw_library(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let wide = area.width >= 86;
    let columns = if wide {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(43), Constraint::Percentage(57)])
            .split(area)
    } else {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(100)])
            .split(area)
    };
    let items = app
        .items
        .iter()
        .map(|item| {
            let author = item
                .authors
                .first()
                .map(|value| value.name.as_str())
                .or(item.author.as_deref())
                .unwrap_or("Unknown author");
            let format = item.format.as_str().to_ascii_uppercase();
            ListItem::new(vec![
                Line::styled(&item.title, Style::default().add_modifier(Modifier::BOLD)),
                Line::from(vec![
                    Span::styled(author, Style::default().fg(MUTED)),
                    Span::styled(format!("  {format}"), Style::default().fg(ACCENT_2)),
                ]),
            ])
        })
        .collect::<Vec<_>>();
    let title = if app.query.is_empty() {
        format!(" Library  {} ", app.items.len())
    } else {
        format!(" Search: '{}'  {} found ", app.query, app.items.len())
    };
    let mut state =
        ListState::default().with_selected((!app.items.is_empty()).then_some(app.selected));
    frame.render_stateful_widget(
        List::new(items)
            .block(
                Block::default()
                    .title(title)
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::DarkGray)),
            )
            .highlight_style(
                Style::default()
                    .fg(Color::Black)
                    .bg(ACCENT)
                    .add_modifier(Modifier::BOLD),
            )
            .highlight_symbol("  "),
        columns[0],
        &mut state,
    );
    if wide {
        draw_book_detail(frame, columns[1], app);
    }
}

fn draw_book_detail(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let lines = app.selected_item().map_or_else(
        || {
            let message = if app.query.is_empty() {
                "Your library is ready for its first book."
            } else {
                "No books match this search."
            };
            vec![
                Line::styled(
                    message,
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Line::raw(""),
                Line::raw(if app.query.is_empty() {
                    "Press i to import an ebook from this computer."
                } else {
                    "Press Esc to clear the search, or / to try another."
                }),
                Line::raw(""),
                Line::styled(
                    "EPUB, PDF, MOBI, AZW3, DOCX, HTML, TXT, CBZ, and KEPUB are supported.",
                    Style::default().fg(MUTED),
                ),
            ]
        },
        |item| {
            let author = item
                .authors
                .first()
                .map(|value| value.name.as_str())
                .or(item.author.as_deref())
                .unwrap_or("Unknown author");
            let formats = item
                .formats
                .iter()
                .map(|value| value.format.as_str().to_ascii_uppercase())
                .collect::<Vec<_>>()
                .join(", ");
            let mut lines = vec![
                Line::styled(
                    item.title.clone(),
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Line::styled(author.to_owned(), Style::default().fg(Color::White)),
                Line::raw(""),
                detail_line(
                    "Format",
                    if formats.is_empty() {
                        item.format.as_str().to_owned()
                    } else {
                        formats
                    },
                ),
                detail_line("Added", item.added_at.clone()),
            ];
            if let Some(series) = &item.series {
                lines.push(detail_line("Series", series.clone()));
            }
            if let Some(publisher) = &item.publisher {
                lines.push(detail_line("Publisher", publisher.clone()));
            }
            if !item.languages.is_empty() {
                lines.push(detail_line("Language", item.languages.join(", ")));
            }
            if !item.tags.is_empty() {
                lines.push(detail_line("Tags", item.tags.join(", ")));
            }
            lines.push(Line::raw(""));
            lines.push(Line::styled(
                item.description
                    .as_deref()
                    .unwrap_or("No description available.")
                    .to_owned(),
                Style::default().fg(if item.description.is_some() {
                    Color::White
                } else {
                    MUTED
                }),
            ));
            lines.push(Line::raw(""));
            lines.push(Line::styled(
                "m  Review metadata    d  Move to Trash",
                Style::default().fg(Color::Yellow),
            ));
            lines
        },
    );
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(PANEL))
            .block(
                Block::default()
                    .title(" Book details ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT_2)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn detail_line(label: &str, value: String) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{label:<10}"), Style::default().fg(MUTED)),
        Span::raw(value),
    ])
}

fn draw_jobs(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let lines = match JobStore::open(&app.paths.jobs).and_then(|store| store.list(None)) {
        Ok(jobs) if jobs.is_empty() => {
            vec![
                Line::styled(
                    "No conversions yet",
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Line::raw(""),
                Line::raw("Conversions queued from the CLI appear here with their latest status."),
                Line::raw(""),
                Line::styled("Press r to check again.", Style::default().fg(MUTED)),
            ]
        }
        Ok(jobs) => jobs
            .iter()
            .rev()
            .take(40)
            .map(|job| {
                let color = match job.status.as_str() {
                    "completed" => ACCENT,
                    "failed" => Color::Red,
                    "running" => ACCENT_2,
                    "canceled" => MUTED,
                    _ => Color::Yellow,
                };
                Line::from(vec![
                    Span::styled(
                        format!("{:<10}", job.status.as_str()),
                        Style::default().fg(color).add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(format!("  {} -> {}  ", job.input_format, job.output_format)),
                    Span::styled(
                        job.id[..job.id.len().min(12)].to_owned(),
                        Style::default().fg(MUTED),
                    ),
                ])
            })
            .collect::<Vec<_>>(),
        Err(error) => vec![
            Line::styled(
                "Conversion history is unavailable",
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            ),
            Line::raw(""),
            Line::raw(format!("Reason: {}", error.code())),
            Line::styled("Press r to try again.", Style::default().fg(MUTED)),
        ],
    };
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .title(" Conversion activity ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT_2)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}
fn draw_devices(frame: &mut ratatui::Frame<'_>, area: Rect) {
    let lines = match destinations::list(Path::new("/Volumes")) {
        Ok(devices) if devices.is_empty() => vec![
            Line::styled(
                "No reader connected",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
            Line::raw(""),
            Line::raw("Connect a Kindle, Kobo, or writable volume."),
            Line::styled("Then press r to look again.", Style::default().fg(MUTED)),
        ],
        Ok(devices) => devices
            .iter()
            .map(|device| {
                Line::from(vec![
                    Span::styled(
                        format!("{:<20}", device.name),
                        Style::default().add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("  {:<8?}", device.kind),
                        Style::default().fg(ACCENT),
                    ),
                    Span::styled(
                        format!("  {}", device.path.display()),
                        Style::default().fg(MUTED),
                    ),
                ])
            })
            .collect(),
        Err(_) => vec![
            Line::styled(
                "Device discovery is unavailable",
                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
            ),
            Line::raw(""),
            Line::raw("Takio could not read mounted volumes on this system."),
        ],
    };
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .title(" Connected readers ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT_2)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}
fn draw_help(frame: &mut ratatui::Frame<'_>, area: Rect) {
    let text = "MOVE\n  j / Down       Next book          k / Up         Previous book\n  PgDn / PgUp    Move by a page     g / G          First / last book\n  Left / Right   Previous / next    1 2 3 4        Jump to a view\n\nACT\n  /              Search library     Esc            Clear search / cancel\n  i              Import a book      m              Review metadata\n  d              Move to Trash      r              Refresh\n  :              Run a command      ?              Show this guide\n  q / Ctrl-C     Quit\n\nMETADATA REVIEW\n  Tab            Switch pane        j / k          Move selection\n  Space          Toggle field       o              Explicit online lookup\n  Enter / a      Review changes     Esc            Cancel without changes\n\nCOMMANDS\n  search <text>  clear  import <path>  trash  metadata  refresh\n  library  jobs  devices  help  quit\n\nTakio shows provenance and applies only fields you select. Online lookup is never automatic.";
    frame.render_widget(
        Paragraph::new(text)
            .block(
                Block::default()
                    .title(" Keyboard guide ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}
fn draw_input(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let popup = centered(area, 72, 7);
    frame.render_widget(Clear, popup);
    let guidance = match app.mode {
        Mode::Search => "Type a title, author, or tag",
        Mode::Import => "Enter an absolute or relative ebook file path",
        Mode::Palette => "Try help, refresh, search <text>, or import <path>",
        Mode::Normal | Mode::ConfirmTrash | Mode::CandidateReview | Mode::ConfirmCandidate => "",
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::styled(guidance, Style::default().fg(MUTED)),
            Line::raw(""),
            Line::from(vec![
                Span::styled(
                    "> ",
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Span::raw(&app.input),
            ]),
        ])
        .block(
            Block::default()
                .title(format!(" {} ", app.mode.input_title()))
                .borders(Borders::ALL)
                .border_style(Style::default().fg(ACCENT)),
        )
        .style(Style::default().bg(PANEL)),
        popup,
    );
    frame.set_cursor_position((
        popup.x
            + 3
            + u16::try_from(app.input.chars().count())
                .unwrap_or(0)
                .min(popup.width.saturating_sub(5)),
        popup.y + 4,
    ));
}
fn draw_confirm(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let popup = centered(area, 64, 9);
    frame.render_widget(Clear, popup);
    let title = app
        .selected_item()
        .map(|item| item.title.as_str())
        .unwrap_or("this book");
    frame.render_widget(
        Paragraph::new(format!(
            "Move '{}' to Trash?\n\nThe book leaves your library, but remains recoverable from Trash.\n\n  Enter / y  Move to Trash     n / Esc  Keep book",
            title
        ))
        .alignment(Alignment::Center)
        .block(
            Block::default()
                .title(" Confirm move to Trash ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Yellow)),
        )
        .style(Style::default().bg(PANEL))
        .wrap(Wrap { trim: true }),
        popup,
    );
}

fn draw_candidate_review(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let Some(review) = app.candidate_review.as_ref() else {
        return;
    };
    let popup = centered(
        area,
        area.width.saturating_sub(4).min(110),
        area.height.saturating_sub(4),
    );
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Block::default()
            .title(format!(" Metadata review: {} ", review.item_title))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(ACCENT))
            .style(Style::default().bg(PANEL)),
        popup,
    );
    let inner = popup.inner(ratatui::layout::Margin {
        horizontal: 1,
        vertical: 1,
    });
    let panes = if inner.width >= 78 {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(38), Constraint::Percentage(62)])
            .split(inner)
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(42), Constraint::Percentage(58)])
            .split(inner)
    };

    let candidate_items = if review.loading {
        vec![ListItem::new("Looking for suggestions...")]
    } else if review.candidates.is_empty() {
        vec![ListItem::new(vec![
            Line::styled("No local suggestions", Style::default().fg(MUTED)),
            Line::raw("Press o to include online lookup."),
        ])]
    } else {
        review
            .candidates
            .iter()
            .map(|candidate| {
                let source = candidate
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let confidence = candidate
                    .get("confidence")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let backend = candidate
                    .pointer("/provenance/backend")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        candidate
                            .pointer("/provenance/pattern")
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("Takio");
                ListItem::new(vec![
                    Line::styled(source, Style::default().add_modifier(Modifier::BOLD)),
                    Line::styled(
                        format!("{confidence} confidence  {backend}"),
                        Style::default().fg(MUTED),
                    ),
                ])
            })
            .collect()
    };
    let mut candidate_state = ListState::default().with_selected(
        (!review.loading && !review.candidates.is_empty()).then_some(review.selected_candidate),
    );
    frame.render_stateful_widget(
        List::new(candidate_items)
            .block(
                Block::default()
                    .title(if review.include_online {
                        " Suggestions: local + online "
                    } else {
                        " Suggestions: local "
                    })
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(
                        if review.focus == CandidateFocus::Candidates {
                            ACCENT
                        } else {
                            Color::DarkGray
                        },
                    )),
            )
            .highlight_style(Style::default().fg(Color::Black).bg(ACCENT))
            .highlight_symbol("> "),
        panes[0],
        &mut candidate_state,
    );

    let current = app
        .items
        .iter()
        .find(|item| item.id == review.item_id)
        .and_then(|item| serde_json::to_value(item).ok());
    let patch = review
        .candidates
        .get(review.selected_candidate)
        .and_then(|candidate| candidate.get("patch"));
    let field_items = if review.fields.is_empty() {
        vec![ListItem::new(Line::styled(
            if review.loading {
                "Fields appear after lookup finishes."
            } else {
                "Choose a suggestion to compare its fields."
            },
            Style::default().fg(MUTED),
        ))]
    } else {
        review
            .fields
            .iter()
            .map(|field| {
                let selected = review.selected_fields.contains(field);
                let old = current
                    .as_ref()
                    .and_then(|value| value.get(field))
                    .map(value_summary)
                    .unwrap_or_else(|| "(empty)".to_owned());
                let proposed = patch
                    .and_then(|value| value.get(field))
                    .map(value_summary)
                    .unwrap_or_else(|| "(clear)".to_owned());
                ListItem::new(vec![
                    Line::from(vec![
                        Span::styled(
                            if selected { "[x] " } else { "[ ] " },
                            Style::default().fg(if selected { ACCENT } else { MUTED }),
                        ),
                        Span::styled(
                            field_label(field),
                            Style::default().add_modifier(Modifier::BOLD),
                        ),
                    ]),
                    Line::styled(
                        format!("    {old} -> {proposed}"),
                        Style::default().fg(MUTED),
                    ),
                ])
            })
            .collect()
    };
    let mut field_state = ListState::default()
        .with_selected((!review.fields.is_empty()).then_some(review.selected_field));
    frame.render_stateful_widget(
        List::new(field_items)
            .block(
                Block::default()
                    .title(" Fields to apply ")
                    .borders(Borders::ALL)
                    .border_style(
                        Style::default().fg(if review.focus == CandidateFocus::Fields {
                            ACCENT
                        } else {
                            Color::DarkGray
                        }),
                    ),
            )
            .highlight_style(Style::default().fg(Color::Black).bg(ACCENT_2))
            .highlight_symbol("> "),
        panes[1],
        &mut field_state,
    );
}

fn draw_candidate_confirm(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let Some(review) = app.candidate_review.as_ref() else {
        return;
    };
    let popup = centered(area, 70, 10);
    frame.render_widget(Clear, popup);
    let fields = review
        .selected_fields
        .iter()
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    frame.render_widget(
        Paragraph::new(format!(
            "Apply these fields to '{}'?\n\n{}\n\nThe full suggestion provenance will be recorded.\n\n  Enter / y  Apply     n / Esc  Back",
            review.item_title, fields
        ))
        .alignment(Alignment::Center)
        .block(
            Block::default()
                .title(" Confirm metadata update ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Yellow)),
        )
        .style(Style::default().bg(PANEL))
        .wrap(Wrap { trim: true }),
        popup,
    );
}

fn value_summary(value: &Value) -> String {
    let raw = match value {
        Value::Null => "(empty)".to_owned(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                value
                    .get("name")
                    .and_then(Value::as_str)
                    .map_or_else(|| value_summary(value), str::to_owned)
            })
            .collect::<Vec<_>>()
            .join(", "),
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| format!("{key}:{}", value_summary(value)))
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    };
    let mut characters = raw.chars();
    let shortened = characters.by_ref().take(70).collect::<String>();
    if characters.next().is_some() {
        format!("{shortened}...")
    } else {
        shortened
    }
}

fn field_label(field: &str) -> String {
    let mut label = String::new();
    for character in field.chars() {
        if character.is_ascii_uppercase() {
            label.push(' ');
            label.push(character.to_ascii_lowercase());
        } else {
            label.push(character);
        }
    }
    let mut chars = label.chars();
    chars
        .next()
        .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default()
}

fn move_index(index: usize, length: usize, delta: isize) -> usize {
    if length == 0 {
        return 0;
    }
    if delta < 0 {
        index.saturating_sub(delta.unsigned_abs())
    } else {
        index.saturating_add(delta as usize).min(length - 1)
    }
}
fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width.saturating_sub(4));
    let height = height.min(area.height.saturating_sub(2));
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use serde_json::json;
    use tempfile::TempDir;

    fn test_app() -> (TempDir, App) {
        let temp = TempDir::new().expect("temp directory");
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite")))
            .expect("test paths");
        let app = App::new(paths).expect("test app");
        (temp, app)
    }

    fn app_with_book() -> (TempDir, App, LibraryItem) {
        let (temp, mut app) = test_app();
        let source = temp.path().join("Ada Writer - Better Title.epub");
        std::fs::write(&source, b"epub fixture").expect("write source");
        let item = app
            .store
            .import(&source, Some("Original Title"), false)
            .expect("import book");
        app.refresh();
        (temp, app, item)
    }

    fn candidate_for(item: &LibraryItem) -> Value {
        json!({
            "schemaVersion": 1,
            "id": "filename:1",
            "source": "filename",
            "confidence": "medium",
            "patch": {
                "title": "Better Title",
                "authors": [{"name": "Ada Writer"}]
            },
            "provenance": {
                "generatedAt": "1970-01-01T00:00:00.000Z",
                "itemId": item.id,
                "sourcePath": item.source_path,
                "pattern": "author-title"
            }
        })
    }

    fn install_candidate_review(app: &mut App, item: &LibraryItem) {
        app.mode = Mode::CandidateReview;
        app.candidate_review = Some(CandidateReview {
            item_id: item.id.clone(),
            item_title: item.title.clone(),
            candidates: Vec::new(),
            selected_candidate: 0,
            fields: Vec::new(),
            selected_field: 0,
            selected_fields: BTreeSet::new(),
            focus: CandidateFocus::Candidates,
            include_online: false,
            loading: true,
        });
        app.accept_candidate_results(vec![candidate_for(item)]);
    }

    fn rendered_text(app: &App, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal.draw(|frame| draw(frame, app)).expect("draw");
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn tabs_have_stable_order() {
        assert_eq!(
            Tab::ALL.iter().map(|tab| tab.title()).collect::<Vec<_>>(),
            vec!["Library", "Jobs", "Devices", "Help"]
        );
    }

    #[test]
    fn tab_navigation_wraps_in_both_directions() {
        let (_temp, mut app) = test_app();
        app.previous_tab();
        assert_eq!(app.tab, Tab::Help);
        app.next_tab();
        assert_eq!(app.tab, Tab::Library);
    }

    #[test]
    fn search_submission_trims_input_and_escape_clears_query() {
        let (_temp, mut app) = test_app();
        app.mode = Mode::Search;
        app.input = "  dune  ".to_owned();
        app.submit_input();
        assert_eq!(app.query, "dune");
        assert!(matches!(app.mode, Mode::Normal));

        app.handle_key(KeyCode::Esc, KeyModifiers::NONE);
        assert!(app.query.is_empty());
    }

    #[test]
    fn input_escape_cancels_and_discards_text() {
        let (_temp, mut app) = test_app();
        app.mode = Mode::Import;
        app.input = "unfinished.epub".to_owned();
        app.handle_key(KeyCode::Esc, KeyModifiers::NONE);
        assert!(matches!(app.mode, Mode::Normal));
        assert!(app.input.is_empty());
        assert_eq!(app.status, "Canceled");
    }

    #[test]
    fn command_navigation_and_unknown_command_feedback_work() {
        let (_temp, mut app) = test_app();
        app.run_command("devices");
        assert_eq!(app.tab, Tab::Devices);
        app.run_command("not-a-command");
        assert!(app.status.contains("Unknown command"));
        assert!(app.status.contains("help"));
    }

    #[test]
    fn command_palette_can_open_metadata_review() {
        let (_temp, mut app, _item) = app_with_book();
        app.mode = Mode::Palette;
        app.input = "metadata".to_owned();
        app.submit_input();
        assert_eq!(app.mode, Mode::CandidateReview);
        assert!(app.candidate_review.is_some());
        app.cancel_candidate_review();
    }

    #[test]
    fn empty_import_is_rejected_without_touching_storage() {
        let (_temp, mut app) = test_app();
        app.mode = Mode::Import;
        app.input = "   ".to_owned();
        app.submit_input();
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(app.status, "Enter a file path to import");
    }

    #[test]
    fn candidate_review_applies_only_selected_fields_and_records_provenance() {
        let (_temp, mut app, item) = app_with_book();
        install_candidate_review(&mut app, &item);
        let review = app.candidate_review.as_mut().expect("review");
        review.selected_fields.clear();
        review.selected_fields.insert("title".to_owned());

        app.confirm_candidate();
        assert_eq!(app.mode, Mode::ConfirmCandidate);
        app.apply_candidate();

        let updated = app.store.get(&item.id).expect("get").expect("item");
        assert_eq!(updated.title, "Better Title");
        assert!(updated.authors.is_empty());
        let audit = updated
            .custom_metadata
            .get("takio_metadata_audit")
            .expect("candidate audit");
        assert!(audit.contains("tui-candidate-review"));
        assert!(audit.contains("selectedFields"));
        assert!(audit.contains("title"));
        assert_eq!(app.mode, Mode::Normal);
    }

    #[test]
    fn candidate_review_requires_a_field_and_cancels_without_mutation() {
        let (_temp, mut app, item) = app_with_book();
        install_candidate_review(&mut app, &item);
        app.candidate_review
            .as_mut()
            .expect("review")
            .selected_fields
            .clear();
        app.confirm_candidate();
        assert_eq!(app.mode, Mode::CandidateReview);
        assert_eq!(app.status, "Select at least one field to apply");

        app.handle_key(KeyCode::Esc, KeyModifiers::NONE);
        let unchanged = app.store.get(&item.id).expect("get").expect("item");
        assert_eq!(unchanged.title, "Original Title");
        assert!(unchanged.custom_metadata.is_empty());
        assert_eq!(app.mode, Mode::Normal);
    }

    #[test]
    fn candidate_review_renders_wide_and_compact_layouts() {
        let (_temp, mut app, item) = app_with_book();
        install_candidate_review(&mut app, &item);

        let wide = rendered_text(&app, 110, 32);
        assert!(wide.contains("Metadata review"));
        assert!(wide.contains("Suggestions: local"));
        assert!(wide.contains("Fields to apply"));
        assert!(wide.contains("Better Title"));

        let compact = rendered_text(&app, 60, 16);
        assert!(compact.contains("Metadata review"));
        assert!(compact.contains("Suggestions"));
        assert!(compact.contains("Fields to apply"));
    }
}
