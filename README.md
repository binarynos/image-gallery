# 📂 Gallery

A zero-dependency photo gallery server, with an optional SQLite-backed
tagging system. Runs on [Bun](https://bun.sh) (uses `Bun.file`, `Bun.Image`
and `bun:sqlite`) — Node compatibility is not maintained.

## Requirements
- [Bun](https://bun.sh)
- No `bun install` needed — no third-party dependencies

## Usage

```bash
# Serve a specific directory
bun server.js /path/to/your/photos

# Defaults to ~/Pictures if no path given
bun server.js
```

Then open **http://localhost:3000** in your browser.

### Custom port
```bash
PORT=8080 bun server.js /path/to/photos
```

## Features
- 📁 Browse folders and subfolders
- 🖼 Image thumbnails in a responsive grid (60 per page)
- 👁 Toggle to hide/show non-image files and folders
- 🔍 Lightbox viewer with prev/next navigation, keyboard arrows, and touch swipe
- 🔗 Deep-linkable URLs (path + page preserved in address bar)
- ⚡ ETag caching for images — no redundant re-downloads
- 🚫 Hidden files (dotfiles) are skipped automatically
- 🏷️ Optional tagging system (below)

## Keyboard shortcuts (lightbox)
| Key | Action |
|-----|--------|
| ← / → | Previous / Next image |
| Home / End | First / Last image |
| Escape | Close lightbox |

## Tagging

Images can be tagged, and tags are searchable alongside filenames. Tag data
lives in a SQLite database at `<gallery root>/gallery.db`, created
automatically on first use (it's hidden from the gallery listing itself).

- **Search bar** (top right): searches both filenames and tags. A token of
  the form `tag:grass` matches that tag exactly; anything else matches as a
  substring of a filename or a tag name. Multiple space-separated tokens are
  ANDed together, e.g. `tag:anime luffy`.
- **🏷 Tags button**: opens a modal listing the 40 most-used tags with their
  image counts. Clicking a tag runs a `tag:<name>` search for it.
- **Lightbox tag editor**: while viewing an image, its tags are shown below
  the image. Click a tag to search for other images with that tag, click the
  `×` to remove it, or type into the input and press Enter to add a new one.
  Changes save automatically.

### Importing tags in bulk (CLI)

For a folder of images with a `tags.txt` file — one line per image, filename
followed by a JSON array of tags:

```
image.jpg ["anime", "one-piece"]
another image.png ["scenery", "sunset", "4k"]
```

Import it with:

```bash
bun scripts/import-tags.js <galleryRoot> <subfolder>

# e.g.
bun scripts/import-tags.js "E:\Gallery" "E:\Gallery\Anime"

# Preview what would be imported without writing anything:
bun scripts/import-tags.js "E:\Gallery" "E:\Gallery\Anime" --dry-run
```

Tags are stored against the image's path relative to `<galleryRoot>`, so
they line up with what the web UI (and the running server) expect — no
server restart needed, the next search or lightbox view picks them up
immediately.
