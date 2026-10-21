# AgentTime interactive prototype

Open `index.html` directly in a modern browser. It is a self-contained, offline HTML prototype with inline CSS and JavaScript and no external requests or dependencies.

All sessions, event timestamps, model labels, and connection states are synthetic. This is product exploration, not an implemented collector or a technical-stack decision. Connecting a source only simulates the interface; no local logs are read. No prompts or source code are included.

Explore the overview, date-range and agent filters, session search and detail drawer, model comparison, metric definitions, idle-gap filtering, and simulated source connection flow. Time values are calculated from synthetic intervals rather than independent chart labels. Incomplete approval coverage produces unavailable work time. Parallel work is summed separately from union elapsed time.

The fixed demo date is 2026-10-21 in Asia/Shanghai. Session work stays within that date; earlier sample days contain additional fictional sessions. This prototype does not settle ingestion schemas, time-zone reporting boundaries, multi-model time allocation, or production persistence.

Only UI preferences are retained locally when browser storage is available. Resetting the demo restores its defaults. It does not access or modify any real agent configuration.
