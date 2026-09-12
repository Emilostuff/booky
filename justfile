# start booky (opens in your browser)
run:
    uv run booky.py

# one-time setup on a mac with homebrew: tools, deps, desktop launcher
install:
    brew install ffmpeg uv just
    uv sync --script booky.py
    osascript -e 'tell application "Finder" to make alias file to (POSIX file "{{justfile_directory()}}/Booky.command") at (path to desktop folder)' >/dev/null || true
    @echo "done. double-click 'Booky.command' on the desktop to start (first time: right-click, open)"
