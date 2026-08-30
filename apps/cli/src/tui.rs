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

#[derive(Clone, Copy, Eq, PartialEq)]
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

enum Mode {
    Normal,
    Search,
    Import,
    Palette,
    ConfirmTrash,
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
    fn selected_item(&self) -> Option<&LibraryItem> {
        self.items.get(self.selected)
    }

    fn submit_input(&mut self) {
        let input = std::mem::take(&mut self.input);
        match self.mode {
            Mode::Search => {
                self.query = input;
                self.refresh();
                self.mode = Mode::Normal;
            }
            Mode::Import => {
                let path = Path::new(input.trim());
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
                self.run_command(input.trim());
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
            _ => self.status = format!("Unknown command: {name}"),
        }
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
                KeyCode::Char('n') | KeyCode::Esc => self.mode = Mode::Normal,
                _ => {}
            },
            Mode::Normal => match code {
                KeyCode::Char('q') => self.should_quit = true,
                KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => {
                    self.should_quit = true
                }
                KeyCode::Down | KeyCode::Char('j') => self.next(),
                KeyCode::Up | KeyCode::Char('k') => self.previous(),
                KeyCode::Right | KeyCode::Tab => {
                    self.tab = Tab::ALL[(Tab::ALL
                        .iter()
                        .position(|tab| *tab == self.tab)
                        .unwrap_or(0)
                        + 1)
                        % Tab::ALL.len()]
                }
                KeyCode::Left | KeyCode::BackTab => {
                    let index = Tab::ALL
                        .iter()
                        .position(|tab| *tab == self.tab)
                        .unwrap_or(0);
                    self.tab = Tab::ALL[(index + Tab::ALL.len() - 1) % Tab::ALL.len()];
                }
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
                KeyCode::Char('r') => self.refresh(),
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
    if area.width < 54 || area.height < 16 {
        frame.render_widget(
            Paragraph::new(
                "Takio needs a terminal at least 54 x 16.\nResize the window or press q to quit.",
            )
            .alignment(Alignment::Center)
            .block(Block::default().borders(Borders::ALL).title(" Takio "))
            .wrap(Wrap { trim: true }),
            area,
        );
        return;
    }
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
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
        Span::styled("  local library", Style::default().fg(MUTED)),
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
        .map(|tab| Line::from(tab.title()))
        .collect::<Vec<_>>();
    let selected = Tab::ALL.iter().position(|tab| *tab == app.tab).unwrap_or(0);
    frame.render_widget(
        Tabs::new(titles)
            .select(selected)
            .highlight_style(Style::default().fg(ACCENT).add_modifier(Modifier::BOLD))
            .divider(Span::styled(" | ", Style::default().fg(Color::DarkGray)))
            .padding(" ", " "),
        vertical[1],
    );
    match app.tab {
        Tab::Library => draw_library(frame, vertical[2], app),
        Tab::Jobs => draw_jobs(frame, vertical[2], app),
        Tab::Devices => draw_devices(frame, vertical[2]),
        Tab::Help => draw_help(frame, vertical[2]),
    }
    let hint = match app.mode {
        Mode::Normal => "/ search  i import  d trash  : commands  ? help  q quit",
        Mode::Search => "Search library  Enter apply  Esc cancel",
        Mode::Import => "Import an ebook path  Enter import  Esc cancel",
        Mode::Palette => "Commands: import <path>, search <text>, refresh, trash, quit",
        Mode::ConfirmTrash => "Move selected book to Trash? y confirm  n cancel",
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
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
        .split(area);
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
            ListItem::new(vec![
                Line::styled(&item.title, Style::default().add_modifier(Modifier::BOLD)),
                Line::styled(author, Style::default().fg(MUTED)),
            ])
        })
        .collect::<Vec<_>>();
    let title = if app.query.is_empty() {
        format!(" Library  {} ", app.items.len())
    } else {
        format!(" Results for '{}'  {} ", app.query, app.items.len())
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
            .highlight_symbol("> "),
        columns[0],
        &mut state,
    );
    let detail=app.selected_item().map_or_else(||"Your library is empty.\n\nPress i to import an EPUB, PDF, MOBI, AZW3, DOCX, HTML, TXT, CBZ, or KEPUB file.".to_owned(),|item|{let author=item.authors.first().map(|value|value.name.as_str()).or(item.author.as_deref()).unwrap_or("Unknown author");let formats=item.formats.iter().map(|value|value.format.as_str()).collect::<Vec<_>>().join(", ");format!("{}\n\n{}\n\nFormats   {}\nAdded     {}\nTags      {}\n\n{}",item.title,author,formats,item.added_at,item.tags.join(", "),item.description.as_deref().unwrap_or("No description yet."))});
    frame.render_widget(
        Paragraph::new(detail)
            .style(Style::default().bg(PANEL))
            .block(
                Block::default()
                    .title(" Details ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT_2)),
            )
            .wrap(Wrap { trim: false }),
        columns[1],
    );
}

fn draw_jobs(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let text = match JobStore::open(&app.paths.jobs).and_then(|store| store.list(None)) {
        Ok(jobs) if jobs.is_empty() => {
            "No conversion jobs yet.\n\nQueue work with the CLI, then monitor it here.".to_owned()
        }
        Ok(jobs) => jobs
            .iter()
            .rev()
            .take(40)
            .map(|job| {
                format!(
                    "{:<10}  {:<9}  {} -> {}",
                    &job.id[..job.id.len().min(10)],
                    job.status.as_str(),
                    job.input_format,
                    job.output_format
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Err(error) => format!("Jobs unavailable: {}", error.code()),
    };
    frame.render_widget(
        Paragraph::new(text)
            .block(
                Block::default()
                    .title(" Conversion queue ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT_2)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}
fn draw_devices(frame: &mut ratatui::Frame<'_>, area: Rect) {
    let text=match destinations::list(Path::new("/Volumes")){Ok(devices)if devices.is_empty()=>"No mounted ebook device found.\n\nConnect a Kindle, Kobo, or writable volume and press r.".to_owned(),Ok(devices)=>devices.iter().map(|device|format!("{:<20}  {:<8?}  {}",device.name,device.kind,device.path.display())).collect::<Vec<_>>().join("\n"),Err(_)=>"Mounted-volume discovery is unavailable on this system.".to_owned()};
    frame.render_widget(
        Paragraph::new(text)
            .block(
                Block::default()
                    .title(" Devices ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT_2)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}
fn draw_help(frame: &mut ratatui::Frame<'_>, area: Rect) {
    let text = "TAKIO KEYBOARD\n\n  j / Down       Next book\n  k / Up         Previous book\n  Left / Right   Switch section\n  /              Search\n  i              Import a book\n  d              Move selected book to Trash\n  r              Refresh\n  :              Command palette\n  ?              Help\n  q              Quit\n\nThe terminal UI and JSON CLI use the same Rust library and SQLite store.";
    frame.render_widget(
        Paragraph::new(text)
            .block(
                Block::default()
                    .title(" Help ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}
fn draw_input(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let popup = centered(area, 72, 5);
    frame.render_widget(Clear, popup);
    let title = match app.mode {
        Mode::Search => " Search ",
        Mode::Import => " Import path ",
        Mode::Palette => " Command ",
        _ => " Input ",
    };
    frame.render_widget(
        Paragraph::new(format!("> {}", app.input))
            .block(
                Block::default()
                    .title(title)
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
        popup.y + 2,
    ));
}
fn draw_confirm(frame: &mut ratatui::Frame<'_>, area: Rect, app: &App) {
    let popup = centered(area, 56, 7);
    frame.render_widget(Clear, popup);
    let title = app
        .selected_item()
        .map(|item| item.title.as_str())
        .unwrap_or("this book");
    frame.render_widget(
        Paragraph::new(format!(
            "Move '{}' to Trash?\n\n  y  Move to Trash     n  Cancel",
            title
        ))
        .alignment(Alignment::Center)
        .block(
            Block::default()
                .title(" Confirm ")
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
    #[test]
    fn tabs_have_stable_order() {
        assert_eq!(
            Tab::ALL.iter().map(|tab| tab.title()).collect::<Vec<_>>(),
            vec!["Library", "Jobs", "Devices", "Help"]
        );
    }
}
