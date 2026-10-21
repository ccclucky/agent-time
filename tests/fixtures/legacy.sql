-- Synthetic snapshot created by the previous Python runtime; no user data.
BEGIN TRANSACTION;
CREATE TABLE directory (
 agent TEXT PRIMARY KEY, path TEXT, enabled INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "directory" VALUES('codex',NULL,0);
CREATE TABLE event (
 source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
 key TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL,
 at_ms INTEGER NOT NULL, model TEXT, PRIMARY KEY(source_id,key)
);
INSERT INTO "event" VALUES('9b6f265a86665b9b8174d005cd372b2ae43bab8a6ad92befd3b28f86b4759ac0','c9d8c2efc344f14ce6b57e921c36d209d69881d392a959dbb28a58dda7696f2e','legacy-turn','start',1792540800000,NULL);
INSERT INTO "event" VALUES('9b6f265a86665b9b8174d005cd372b2ae43bab8a6ad92befd3b28f86b4759ac0','58cf1d3d879db41220491eb4496ada577cdf6aaab619a77bbbdf4f9f1d3fb6cc','legacy-turn','complete',1792541400000,NULL);
INSERT INTO "event" VALUES('9b6f265a86665b9b8174d005cd372b2ae43bab8a6ad92befd3b28f86b4759ac0','67777d8439ac5d10539c26ac3f2cdd52ff95fdbc3e00e1ed4f356ea6e2e9fee8','legacy-turn','model',1792540801000,'模型😀');
CREATE TABLE source (
 id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
 project TEXT NOT NULL, client TEXT NOT NULL, issues TEXT NOT NULL, last_error TEXT, config_root TEXT,
 imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "source" VALUES('9b6f265a86665b9b8174d005cd372b2ae43bab8a6ad92befd3b28f86b4759ac0','/legacy/selected.jsonl','legacy-session','legacy','cli','[]',NULL,NULL,'2026-10-21 07:44:02');
COMMIT;
