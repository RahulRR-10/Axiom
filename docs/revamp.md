The Redesign in Plain Terms

What's wrong now: It saves to the most recently used note silently. No control, wrong note, no feedback.

The new flow:
Text selection → floating bar → "Save to Note" button → small popover appears → user picks a note → saved.
The popover shows notes in this order: session default (if set) → same subject as source file → recently edited. Three to four notes max. Enter key saves to the pre-highlighted one.

Session memory — the key idea:
The first time they pick a note, that note becomes the pinned default for the rest of the session. From that point on the popover opens with it already highlighted — they just press Enter. One click.
Reset the session default only when they switch vaults or restart the app. Not on tab switches, not on document changes.

Edge cases to handle:

Note gets deleted → detect it, clear the session default, reopen the popover with a toast saying "that note was deleted"
Note is currently open in the editor → don't write to disk, send a live append event so CodeMirror updates in real time and autosave handles persistence
Same text saved twice → warn them in the popover but don't block it
Vault switch → clear session default immediately since note IDs belong to a different database
Write failure → show a toast, but keep the session default intact since the note still exists


What to build:
One new button in FloatingActionBar. One small popover component. One new IPC handler notes:appendChunk that checks the note exists, detects duplicates, handles the live-vs-disk append split, and broadcasts to other windows. That's it. Sonnet 4.6ExtendedClaude is AI and can make mistakes. Please double-check responses.