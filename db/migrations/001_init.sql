-- 001_init — players, matches, live seats.
--
-- Kept deliberately small: this is a museum exhibit, not an account system. There
-- are no credentials, no email, no age, no free-text a visitor could type beyond a
-- 16-char nickname. See docs/database.md for the retention rules that go with it.

CREATE TABLE IF NOT EXISTS players (
  player_id      CHAR(36)     NOT NULL COMMENT 'GUID minted by the client, stable across visits',
  display_name   VARCHAR(32)  NOT NULL COMMENT 'last nickname used; overwritten, not versioned',
  first_seen_at  DATETIME     NOT NULL,
  last_seen_at   DATETIME     NOT NULL,
  games_played   INT UNSIGNED NOT NULL DEFAULT 0,
  wins           INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id),
  KEY idx_players_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS matches (
  match_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_id      CHAR(6)      NOT NULL COMMENT 'the shareable room code',
  game         VARCHAR(16)  NOT NULL COMMENT 'room name: dakon, egrang, ...',
  started_at   DATETIME     NOT NULL,
  ended_at     DATETIME     NULL,
  outcome      ENUM('in_progress','completed','forfeited','abandoned')
                            NOT NULL DEFAULT 'in_progress',
  -- NULL means "no single winner": a tie, or a match that never finished.
  winner_player_id CHAR(36) NULL,
  PRIMARY KEY (match_id),
  KEY idx_matches_room (room_id),
  KEY idx_matches_game_started (game, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS match_players (
  match_id     BIGINT UNSIGNED NOT NULL,
  seat         TINYINT UNSIGNED NOT NULL COMMENT '0-based seat index within the room',
  -- Nullable: a client that never sent a playerId (older build, cleared storage)
  -- still gets a result row, it just cannot be linked to a profile.
  player_id    CHAR(36)     NULL,
  session_id   VARCHAR(32)  NOT NULL COMMENT 'Colyseus sessionId — per connection, not an identity',
  display_name VARCHAR(32)  NOT NULL,
  score        INT          NOT NULL DEFAULT 0,
  is_winner    BOOLEAN      NOT NULL DEFAULT FALSE,
  PRIMARY KEY (match_id, seat),
  KEY idx_match_players_player (player_id),
  CONSTRAINT fk_match_players_match FOREIGN KEY (match_id)
    REFERENCES matches (match_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who is sitting where right now. Written on join/leave/reconnect, wiped on boot:
-- rows describe live sockets, and no socket survives a server restart.
CREATE TABLE IF NOT EXISTS live_sessions (
  session_id   VARCHAR(32)  NOT NULL,
  room_id      CHAR(6)      NOT NULL,
  game         VARCHAR(16)  NOT NULL,
  player_id    CHAR(36)     NULL,
  display_name VARCHAR(32)  NOT NULL,
  seat         TINYINT UNSIGNED NOT NULL,
  connected    BOOLEAN      NOT NULL DEFAULT TRUE,
  joined_at    DATETIME     NOT NULL,
  updated_at   DATETIME     NOT NULL,
  PRIMARY KEY (session_id),
  KEY idx_live_sessions_room (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
