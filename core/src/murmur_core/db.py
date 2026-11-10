from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .models import Base

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30}, pool_pre_ping=True)

        @event.listens_for(engine, "connect")
        def _pragmas(dbapi_conn, _):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=30000")
            cur.close()

        return engine
    return create_engine(url, pool_pre_ping=True)


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False, autoflush=True)


@contextmanager
def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


FTS_DDL = [
    "CREATE VIRTUAL TABLE IF NOT EXISTS utterances_fts USING fts5(text, content='utterances', content_rowid='id', tokenize='trigram')",
    """CREATE TRIGGER IF NOT EXISTS utterances_ai AFTER INSERT ON utterances BEGIN
         INSERT INTO utterances_fts(rowid, text) VALUES (new.id, new.text);
       END""",
    """CREATE TRIGGER IF NOT EXISTS utterances_ad AFTER DELETE ON utterances BEGIN
         INSERT INTO utterances_fts(utterances_fts, rowid, text) VALUES ('delete', old.id, old.text);
       END""",
    """CREATE TRIGGER IF NOT EXISTS utterances_au AFTER UPDATE OF text ON utterances BEGIN
         INSERT INTO utterances_fts(utterances_fts, rowid, text) VALUES ('delete', old.id, old.text);
         INSERT INTO utterances_fts(rowid, text) VALUES (new.id, new.text);
       END""",
]


def init_db(engine: Engine) -> None:
    Base.metadata.create_all(engine)
    if engine.dialect.name == "sqlite":
        with engine.begin() as conn:
            for stmt in FTS_DDL:
                conn.execute(text(stmt))
    # Future schema changes: add ordered migration functions keyed by version and bump SCHEMA_VERSION.
    with engine.begin() as conn:
        from .models import State

        row = conn.execute(text("SELECT value_json FROM state WHERE key='schema_version'")).fetchone()
        if row is None:
            conn.execute(text("INSERT INTO state(key, value_json) VALUES ('schema_version', :v)"), {"v": str(SCHEMA_VERSION)})
