use std::io::{self, Stdout};
use std::path::Path;
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
}

impl Mode {
    const fn input_title(self) -> &'static str {
        match self {
            Self::Search => "Search library",
            Self::Import => "Import a book",
            Self::Palette => "Run a command",
            Self::Normal | Self::ConfirmTrash => "Input",
        }
    }
}

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
                self.mode = Mode::Normal;
            }
            Mode::Normal | Mode::ConfirmTrash => {}
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
        (Mode::Normal, Tab::Library) => "j/k move  / search  i import  d trash  ? help",
        (Mode::Normal, Tab::Jobs | Tab::Devices) => "Left/Right switch  r refresh  ? help  q quit",
        (Mode::Normal, Tab::Help) => "1-4 jump to view  Left/Right switch  q quit",
        (Mode::Search, _) => "Enter search  Esc cancel",
        (Mode::Import, _) => "Enter import  Esc cancel",
        (Mode::Palette, _) => "Enter run  Esc cancel",
        (Mode::ConfirmTrash, _) => "Enter/y move  n/Esc keep",
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
    if !matches!(app.mode, Mode::Normal | Mode::ConfirmTrash) {
        draw_input(frame, area, app);
    } else if matches!(app.mode, Mode::ConfirmTrash) {
        draw_confirm(frame, area, app);
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
                "d  Move to Trash",
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
    let text = "MOVE\n  j / Down       Next book          k / Up         Previous book\n  PgDn / PgUp    Move by a page     g / G          First / last book\n  Left / Right   Previous / next    1 2 3 4        Jump to a view\n\nACT\n  /              Search library     Esc            Clear search / cancel\n  i              Import a book      d              Move book to Trash\n  r              Refresh            :              Run a command\n  ?              Show this guide    q / Ctrl-C     Quit\n\nCOMMANDS\n  search <text>  clear  import <path>  trash  refresh\n  library  jobs  devices  help  quit\n\nTakio keeps destructive actions behind confirmation. The CLI and TUI share the same local library.";
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
        Mode::Normal | Mode::ConfirmTrash => "",
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
    use tempfile::TempDir;

    fn test_app() -> (TempDir, App) {
        let temp = TempDir::new().expect("temp directory");
        let paths = LibraryPaths::resolve(None, Some(&temp.path().join("library.sqlite")))
            .expect("test paths");
        let app = App::new(paths).expect("test app");
        (temp, app)
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
    fn empty_import_is_rejected_without_touching_storage() {
        let (_temp, mut app) = test_app();
        app.mode = Mode::Import;
        app.input = "   ".to_owned();
        app.submit_input();
        assert!(matches!(app.mode, Mode::Normal));
        assert_eq!(app.status, "Enter a file path to import");
    }
}
