#!/bin/sh
# What: Run one Entire Cursor hook.
# Why: The hook's shell does not load ~/.bashrc, so `command -v entire` never
# sees ~/.local/bin/entire and the chat is dropped.
# What breaks if removed: Cursor chats in this repo are not recorded.
if [ -x "$HOME/.local/bin/entire" ]; then
  exec "$HOME/.local/bin/entire" hooks cursor "$1"
fi
if command -v entire >/dev/null 2>&1; then
  exec entire hooks cursor "$1"
fi
exit 0
