//! The command line of docs/cli.md, as `clap` derive types.

use std::path::PathBuf;

use clap::{ColorChoice, Parser, Subcommand, ValueEnum};
use mwf_app::StatusFilter;

/// mwf: a project-local wiki engine for coding agents.
#[derive(Debug, Parser)]
#[command(name = "mwf", version, color = ColorChoice::Never, term_width = 100)]
pub(crate) struct Cli {
    /// Print `{"ok": true, "data": …}` or `{"ok": false, "error": …}` instead of text.
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub(crate) enum Command {
    /// Create .mwf/ in this git repository root.
    Init {
        /// Keep the wiki on this machine: add /.mwf/ to .gitignore.
        #[arg(long)]
        local: bool,
    },

    /// Print a page: frontmatter, body, rev, links out and links in.
    Show {
        /// The page's slug (its file name in .mwf/pages/ without .md).
        slug: String,
    },

    /// BM25 search over pages; the words of QUERY are joined with spaces.
    Search {
        /// Words to search for.
        #[arg(required = true, num_args = 1..)]
        query: Vec<String>,
        #[command(flatten)]
        filter: Filter,
        /// Maximum number of results.
        #[arg(long, value_name = "N", default_value_t = mwf_app::DEFAULT_SEARCH_LIMIT)]
        limit: usize,
    },

    /// List pages by slug.
    List {
        #[command(flatten)]
        filter: Filter,
    },

    /// Print the table of contents rendered from the current pages.
    Index {
        /// Also rewrite .mwf/index.md.
        #[arg(long)]
        rebuild: bool,
    },

    /// Print the last N lines of log.md, oldest first.
    Log {
        #[arg(short = 'n', value_name = "N", default_value_t = 20)]
        n: usize,
    },

    /// Check every page; exits 1 when there is an error.
    Lint,

    /// Create a page; the body is read from stdin.
    New {
        /// The new page's slug: a-z, 0-9 and -.
        slug: String,
        /// preference, decision, knowledge, incident or task.
        #[arg(long = "type", value_name = "TYPE")]
        page_type: String,
        /// The page title.
        #[arg(long, allow_hyphen_values = true)]
        title: String,
        /// One line saying what the page is about; shown in index.md and search results.
        #[arg(long, allow_hyphen_values = true)]
        summary: String,
        /// A tag; repeat for more.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },

    /// Replace a page's body with stdin, if REV is still its rev.
    Write {
        /// The page's slug.
        slug: String,
        /// The rev from `mwf show`.
        #[arg(long)]
        rev: String,
    },

    /// Replace the one occurrence of OLD in a page's body with NEW.
    Patch {
        /// The page's slug.
        slug: String,
        /// The text to replace; it must occur exactly once in the body.
        #[arg(long, allow_hyphen_values = true, required_unless_present = "old_file")]
        old: Option<String>,
        /// Read OLD from a file.
        #[arg(long, value_name = "PATH", conflicts_with = "old")]
        old_file: Option<PathBuf>,
        /// The replacement text.
        #[arg(long, allow_hyphen_values = true, required_unless_present = "new_file")]
        new: Option<String>,
        /// Read NEW from a file.
        #[arg(long, value_name = "PATH", conflicts_with = "new")]
        new_file: Option<PathBuf>,
    },

    /// Change frontmatter fields.
    Set {
        /// The page's slug.
        slug: String,
        /// A new title.
        #[arg(long, allow_hyphen_values = true)]
        title: Option<String>,
        /// A new type: preference, decision, knowledge, incident or task.
        #[arg(long = "type", value_name = "TYPE")]
        page_type: Option<String>,
        /// A new summary.
        #[arg(long, allow_hyphen_values = true)]
        summary: Option<String>,
        /// Add a tag; repeat for more.
        #[arg(long = "tag", value_name = "TAG")]
        add_tags: Vec<String>,
        /// Remove a tag; repeat for more.
        #[arg(long = "untag", value_name = "TAG")]
        remove_tags: Vec<String>,
    },

    /// Set a page's status to archived.
    Archive {
        /// The page's slug.
        slug: String,
    },

    /// Set a page's status back to active.
    Unarchive {
        /// The page's slug.
        slug: String,
    },

    /// Rename a page and rewrite the links to it.
    Rename {
        /// The page's current slug.
        old: String,
        /// Its new slug.
        new: String,
    },

    /// Move a page to .mwf/trash/.
    Delete {
        /// The page's slug.
        slug: String,
        /// Turn links to the page into plain text instead of refusing.
        #[arg(long)]
        unlink: bool,
    },
}

/// Page filters shared by `search` and `list`.
#[derive(Debug, clap::Args)]
pub(crate) struct Filter {
    /// Only pages of this type; repeat to allow several.
    #[arg(long = "type", value_name = "TYPE")]
    pub types: Vec<String>,
    /// Only pages with this tag; repeat to require several.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// Which pages by status.
    #[arg(long, value_enum, default_value_t = Status::Active)]
    pub status: Status,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum Status {
    Active,
    Archived,
    All,
}

impl From<Status> for StatusFilter {
    fn from(s: Status) -> StatusFilter {
        match s {
            Status::Active => StatusFilter::Active,
            Status::Archived => StatusFilter::Archived,
            Status::All => StatusFilter::All,
        }
    }
}
