use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use std::str::FromStr;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct LocalEvent {
    pub event_id: String,
    pub event_type: String,
    pub payload: String,
    pub created_at: i64,
    pub synced_at: Option<i64>,
    pub retry_count: i32,
}

pub struct OfflineStore {
    pool: SqlitePool,
}

impl OfflineStore {
    pub async fn init(db_path: PathBuf) -> Result<Self, sqlx::Error> {
        let conn_str = format!("sqlite://{}?mode=rwc", db_path.to_string_lossy());
        let options = SqliteConnectOptions::from_str(&conn_str)?
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        // Initialize schema with WAL mode and unique event_id
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS local_events (
                event_id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                synced_at INTEGER,
                retry_count INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_local_events_synced ON local_events (synced_at);
            "#,
        )
        .execute(&pool)
        .await?;

        Ok(Self { pool })
    }

    pub async fn queue_event(&self, event_type: &str, payload: &str) -> Result<String, sqlx::Error> {
        let event_id = format!("evt_{}", Uuid::new_v4());
        let now = chrono::Utc::now().timestamp_millis();

        sqlx::query(
            "INSERT INTO local_events (event_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)"
        )
        .bind(&event_id)
        .bind(event_type)
        .bind(payload)
        .bind(now)
        .execute(&self.pool)
        .await?;

        Ok(event_id)
    }

    pub async fn fetch_unsynced(&self, limit: i64) -> Result<Vec<LocalEvent>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT event_id, event_type, payload, created_at, synced_at, retry_count
             FROM local_events
             WHERE synced_at IS NULL
             ORDER BY created_at ASC
             LIMIT ?"
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut events = Vec::new();
        for r in rows {
            events.push(LocalEvent {
                event_id: r.get("event_id"),
                event_type: r.get("event_type"),
                payload: r.get("payload"),
                created_at: r.get("created_at"),
                synced_at: r.get("synced_at"),
                retry_count: r.get("retry_count"),
            });
        }
        Ok(events)
    }

    pub async fn mark_synced(&self, event_id: &str) -> Result<(), sqlx::Error> {
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query("UPDATE local_events SET synced_at = ? WHERE event_id = ?")
            .bind(now)
            .bind(event_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn increment_retry(&self, event_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE local_events SET retry_count = retry_count + 1 WHERE event_id = ?")
            .bind(event_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn cleanup_synced(&self, older_than_ms: i64) -> Result<u64, sqlx::Error> {
        let cutoff = chrono::Utc::now().timestamp_millis() - older_than_ms;
        let res = sqlx::query("DELETE FROM local_events WHERE synced_at IS NOT NULL AND synced_at < ?")
            .bind(cutoff)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected())
    }
}
