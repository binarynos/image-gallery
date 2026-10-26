# 📂 Gallery

A zero-dependency photo gallery server built with plain Node.js.

## Requirements
- Node.js 16 or newer (uses built-in `http`, `fs`, `path`, `crypto`)
- No npm install needed

## Usage

```bash
# Serve a specific directory
node server.js /path/to/your/photos

# Defaults to ~/Pictures if no path given
node server.js
```

Then open **http://localhost:3000** in your browser.

### Custom port
```bash
PORT=8080 node server.js /path/to/photos
```

## Features
- 📁 Browse folders and subfolders
- 🖼 Image thumbnails in a responsive grid (60 per page)
- 👁 Toggle to hide/show non-image files and folders
- 🔍 Lightbox viewer with prev/next navigation, keyboard arrows, and touch swipe
- 🔗 Deep-linkable URLs (path + page preserved in address bar)
- ⚡ ETag caching for images — no redundant re-downloads
- 🚫 Hidden files (dotfiles) are skipped automatically

## Keyboard shortcuts (lightbox)
| Key | Action |
|-----|--------|
| ← / → | Previous / Next image |
| Home / End | First / Last image |
| Escape | Close lightbox |
