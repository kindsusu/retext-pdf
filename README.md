# Retext PDF

> Formerly named EDITOR_KIM (renamed in v4.0.0). The repository moved to `kindsusu/retext-pdf`; GitHub redirects the old URL.

[![Release](https://img.shields.io/github/v/release/kindsusu/retext-pdf?label=release)](https://github.com/kindsusu/retext-pdf/releases/latest) [![CI](https://github.com/kindsusu/retext-pdf/actions/workflows/ci.yml/badge.svg)](https://github.com/kindsusu/retext-pdf/actions/workflows/ci.yml) ![Windows 10/11 x64](https://img.shields.io/badge/Windows-10%20%7C%2011%20x64-0078D4) [![License](https://img.shields.io/badge/license-personal%20use-lightgrey)](LICENSE)

![Retext PDF](assets/hero.png)

A local Windows editor that changes PDF text objects directly and removes sensitive text for real, with Markdown editing on the side. Everything runs on your PC — your documents never leave it.

![Retext PDF 5.0: toolbar, page list, and a PDF at "fit whole page"](store/screenshot-1-pdf.png)

[한국어](README.ko.md) · [Plan](PLAN.md) · [Releases](https://github.com/kindsusu/retext-pdf/releases)

## Download

**Recommended: [get it from the Microsoft Store](https://apps.microsoft.com/detail/9MXQD6ZHX6HH)** — the package is signed by Microsoft, so it installs without a SmartScreen warning, and the Store keeps it up to date.

To download an installer directly, use **[Releases](https://github.com/kindsusu/retext-pdf/releases/latest)**.

| File | Use it when |
|---|---|
| `Retext-PDF-<version>-setup.exe` | You want a normal install (per user, no admin rights). Adds Retext PDF to the PDF "Open with" list and a Start-menu shortcut. |
| `Retext-PDF-<version>-portable.exe` | You want to run it from a folder or USB stick without installing. |

Requirements: Windows 10 or 11 (x64), about 400 MB of disk space. No account or internet connection is needed.

**First launch and SmartScreen (Releases installers only).** The Releases builds are not code-signed, so Windows may show "Windows protected your PC". Check that the file came from this repository's Releases page, then choose **More info → Run anyway**. Alternatively, right-click the downloaded file → **Properties** → tick **Unblock** → OK. Do not turn off Microsoft Defender to get past the warning.

## What's new in 5.0

- **A new, lighter look.** A light ivory theme and a toolbar with an icon and a label for every feature, grouped as 파일 (file) · 편집 (edit) · 도구 (tools) · 쪽 (pages) · 문서 (document) — nothing is hidden in menus. A context bar under the toolbar shows the current tool's options and a one-line hint. PDFs open with the page list on the left at "fit whole page" zoom.
- **Password-protected PDFs open.** You are asked for the password; owner-restricted PDFs open directly. The first save of such a document goes through Save As, and the saved copy has no password.
- **Password protection.** **암호** saves an AES-256 encrypted copy, optionally restricting printing, copying, and editing with an owner password. The open document stays unchanged, and passwords are never stored.
- **Print** (Ctrl+P), including unsaved edits; you can print only the selected pages.
- **Page list.** Select several pages (Ctrl/Shift), drag them to reorder with a drop indicator, insert blank pages, duplicate pages, insert another PDF at a position (also by dropping a PDF file onto the page list), and use the right-click menu on the selection.
- **Page numbers** in 4 formats (`1`, `1 / N`, `- 1 -`, `1쪽`) and 5 positions, with size, margin, start number, skip-first-page, and color. Running it again replaces the previous numbers, and they can be removed.
- **Text boxes.** Click on the page and type (font, size, color); a text box can be edited later like any other line.
- **Stamp library.** Keep PNG/JPEG stamps and signatures (up to 40, stored in the app's data folder) and place them on any document; transparent PNGs keep their transparency.
- Shortcut help (Ctrl+/ or F1), tool keys (E, T, S, W; Esc goes back), stacked notifications, and clicking empty space closes the line editor (applying the edit if the text changed; Esc cancels).
- Fixes: transparent PNG images were flattened onto white and hid the text underneath; the bundled sample PDF's title metadata contained its whole source HTML; a closed line editor reopened after zooming.

Full notes: [v5.0.0 release](https://github.com/kindsusu/retext-pdf/releases/tag/v5.0.0).

## Features

- Direct PDF text-object editing with the original embedded font, falling back to a subset Malgun Gothic for missing glyphs
- Redaction that removes the selected characters from the PDF and verifies the removal by re-extracting text; a search hit can also be masked with "mask the whole line"
- Full-text search (Ctrl+F) across every page with prev/next navigation, a match counter, match-case, and highlighted results
- Page tools: extract/delete pages, rotate pages 90° at a time, reorder, duplicate, insert blank pages or another PDF, add page numbers, split into N-page files, merge PDFs, export pages as PNG/JPEG, and reduce file size by downsampling (single document or several files at once, without opening them)
- Add content: text boxes, stamps and signatures from a stamp library, and JPEG/PNG images
- Print (Ctrl+P), open password-protected PDFs, and save an AES-256 password-protected copy
- A status bar with the current page / total pages, a page-number jump box, and zoom presets (쪽 전체 보기 = fit whole page, 폭 맞춤 = fit width, 50–400%); a sidebar with 파일 | 쪽 tabs (open files and the page list)
- An empty state with quick tools (merge, reduce several files' size, export images) and a full-window drag-and-drop overlay when no document is open
- Open PDFs straight from a browser or mail client via the Windows "Open with" association (temp-file downloads show a banner and save with "Save As")
- Undo/redo, multi-line editing, fit-to-width, and move — one edit is always one undo step, even when alignment is kept
- Safe editing: every line edit is applied, saved, reopened, and checked before it replaces the document; anything that fails is rolled back
- A progress dialog with a cancel button for long document tools (size reduction, export, split, merge, page cleanup), which restores the document or reports how many files were saved when cancelled
- An undo toast after page deletion, size reduction, rotation, or reordering; notifications stack instead of replacing each other
- Markdown editing with a sanitized live preview

| Before | After |
|---|---|
| ![Before editing](assets/edit-before.png) | ![After editing](assets/edit-after.png) |

## Run from source

```bash
git clone https://github.com/kindsusu/retext-pdf.git
cd retext-pdf
npm install
npm start
```

Double-clicking `run-retext-pdf.bat` runs the same source without opening a terminal. Use `npm run serve` for the browser-only mode at <http://localhost:4747>; native file dialogs and PNG insertion are Electron-only there.

## PDF editing

![Architecture](assets/architecture.svg)

Click a line, edit it, and press Enter to confirm. PDFs exported from Excel, Hangul or Chromium split one line into many text objects (per font run, sometimes per character); fragments that share a baseline and sit next to each other are merged into one editable box, while table cells stay separate (gap size plus a vertical-rule check). Text keeps its original embedded font where possible; characters missing from that font fall back to Malgun Gothic. The **폰트 맞추기** (font match) dialog opens for image-backed hidden text or a text box where you've already chosen a font — pick an installed font or import a TTF, preview the result, and apply with undo support. When the original font cannot be reused (for example, text drawn as an image), the dialog says so and you choose the closest-looking font yourself; only plain TTF fonts are supported, not OTF or variable fonts.

![Redaction pipeline](assets/redaction.svg)

Text redaction removes the selected characters from the PDF object, adds a covering rectangle, and re-extracts the page text to confirm the removal. Text inside a scanned image can only be visually covered, not removed.

## Privacy and safety

- Documents never leave your PC. There is no account, cloud service, or AI connection; the built-in server listens on `127.0.0.1` only and rejects requests from other sites (host and origin checks).
- Markdown links open in your default browser, and remote images in Markdown are not loaded automatically.
- Redaction removes characters from the file itself, then re-extracts the page text to confirm; scanned images can only be covered.

## PDF tools

The toolbar's **도구** (tools), **쪽** (pages), and **문서** (document) groups hold these tools (all undoable except image export and split, which write new files and leave the open document untouched):

- **글 상자** (text box, `T`) — click on the page and type; choose font, size, and color in the context bar
- **도장** (stamp, `S`) — place a PNG/JPEG stamp or signature from the stamp library; drag to move, handle to resize
- **그림** (image) — insert a JPEG/PNG; drag to move, handle to resize
- **가리기** (redact, `W`) — drag a rectangle to cover an area
- **왼쪽 / 오른쪽** — rotate the current page (or the pages selected in the page list) 90°
- **빈 쪽** / **끼워 넣기** — insert a blank page, or another PDF's pages, after the current page
- **쪽 번호** — add page numbers to every page (format, position, size, margin, start number, skip first page, color); running it again replaces them
- **쪽 정리…** — extract/delete pages via checkbox thumbnails or a `1,3-5` range
- **병합** — merge several PDFs in a chosen order
- **이미지로** — export pages as PNG/JPEG at 96–300 dpi into a folder
- **용량 줄이기** — downsample images above a dpi threshold, re-encode as JPEG, optional target size (transparent images skipped); with no document open it runs on several PDF files at once and writes `<name>-축소.pdf` next to each
- **분할** — split the document into N-page files in a chosen folder
- **암호** — save an AES-256 encrypted copy with an open password and optional print/copy/modify restrictions; the open document is not changed

In the sidebar's **쪽** tab, Ctrl/Shift-click selects several pages; drag them to reorder, press Delete to remove them, or drop a PDF file onto the list to insert it there. The right-click menu offers rotate left/right, duplicate, blank page before/after, insert PDF, save the selected pages as a new PDF (따로 저장…), and delete.

Rotated pages keep their text, redaction, search, and drag-to-move overlays aligned — the UI converts between the PDF's unrotated coordinate space and the rotated on-screen layout for every box and highlight.

## Shortcuts

Press `Ctrl+/` or `F1` in the app for the full list.

| Key | Action |
|---|---|
| `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` | Open / save / save as |
| `Ctrl+P` | Print |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+F` | Open the search bar |
| `Enter` / `Shift+Enter` (in the search box) | Next / previous match |
| `E` / `T` / `S` / `W` | 글자 고치기 (edit text) / 글 상자 (text box) / 도장 (stamp) / 가리기 (redact) |
| `Esc` | Back to 글자 고치기, or close the open panel |
| `PageUp` / `PageDown` / `Home` / `End` | Jump a page / to the first / last page |
| `Ctrl`+click / `Shift`+click, `Ctrl+A`, `Delete` (in the page list) | Select pages, select all, delete the selected pages |
| `Ctrl` + mouse wheel | Zoom the PDF around the cursor |
| `Ctrl+=` / `Ctrl+-` | Zoom in / out |
| `Ctrl+0` / `Ctrl+1` | Fit page width / fit whole page |
| `Ctrl+/` / `F1` | Shortcut help |
| `F12` | Developer tools |

## FAQ

**Can the SmartScreen warning be removed?** The [Microsoft Store version](https://apps.microsoft.com/detail/9MXQD6ZHX6HH) is signed by Microsoft and shows no warning. The Releases installers are unsigned, so use "More info → Run anyway" or "Unblock" as described above.

**Some characters changed to Malgun Gothic after editing.** A PDF usually embeds only the characters it already uses. New characters that the embedded font lacks are drawn with Malgun Gothic. Use **폰트 맞추기** to pick a closer installed or TTF font.

**An edit was refused with a reason.** Lines containing math symbols or emoji that no available font can draw, and a few PDFs whose fonts store a different character than the one typed, are refused instead of saving wrong text.

**Can I open a password-protected PDF?** Yes. Retext PDF asks for the password; PDFs that only restrict printing or editing open directly. The first save goes through Save As, and the saved copy has no password — use **암호** to protect it again.

## Development

```bash
npm test
npm audit
npm run dist   # release builds
```

```text
app/                    UI, local server, PDF engine, tests
assets/                 README artwork and diagrams
tools/                  fixture and icon regeneration tools
workspace/              fictional test documents
```

## Limits

- Targets Windows 10+ and is verified on Windows 11.
- Does not directly edit text inside scanned images.
- Complex CJK ligatures, vertical text, and unusual fonts may require fallback.
- A stamp placed on a rotated page rotates with the page. Stamps in the library cannot be renamed.
- Password protection rewrites the file, so existing digital signatures become invalid.
- Review the license before business or commercial use.

## License

Free for personal, non-commercial use. Company, workplace, or commercial use requires prior written permission from the copyright holder. See [LICENSE](LICENSE).
