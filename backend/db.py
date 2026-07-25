"""SQLAlchemy models + engine for user accounts and saved work.

DATABASE_URL controls where this points:
  - unset            -> local SQLite file (./buddy.db), fine for dev
  - postgres://...    -> any Postgres instance (Supabase, Cloud SQL, etc.) — required in
                         production since Cloud Run's filesystem is not persistent across
                         redeploys/instances.

Supabase gives you the connection string as "postgres://...", SQLAlchemy's psycopg2 driver
wants "postgresql://..." — normalized below so either form works.
"""
import os
from datetime import datetime, timezone

from sqlalchemy import (
    create_engine, Column, Integer, String, DateTime, ForeignKey, JSON, Boolean, text, inspect,
)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

# Treat an empty/whitespace value the same as unset — os.getenv's default only applies when
# the var is absent, and a blank DATABASE_URL (easy to leave behind in .env or Cloud Run)
# would otherwise crash the whole app at import with an unparseable-URL error.
DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip() or "sqlite:///./buddy.db"
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

IS_SQLITE = DATABASE_URL.startswith("sqlite")

if IS_SQLITE:
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    # Cloud Run freezes/idles instances, so pooled connections go stale and the next query
    # fails with "server closed the connection unexpectedly". pool_pre_ping re-validates
    # before handing one out; recycle caps connection age. Pool is kept small because each
    # Cloud Run instance holds its own, and Supabase caps total connections.
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        pool_recycle=1800,
        pool_size=5,
        max_overflow=5,
    )
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    # Nullable: Google-signed-in accounts never set a password.
    password_hash = Column(String, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # Quota counters live in the DB, not memory: Cloud Run runs several instances and
    # restarts freely, so in-process counters would reset and be per-instance.
    generations_used = Column(Integer, nullable=False, default=0, server_default="0")
    video_generations_used = Column(Integer, nullable=False, default=0, server_default="0")

    # Subscription state, driven by Stripe webhooks. is_paid is the effective switch the
    # quota gate reads, so a comped account can be granted by flipping it directly.
    is_paid = Column(Boolean, nullable=False, default=False, server_default=text("0") if IS_SQLITE else text("false"))
    stripe_customer_id = Column(String, nullable=True, index=True)
    stripe_subscription_id = Column(String, nullable=True)
    subscription_status = Column(String, nullable=True)  # active | canceled | past_due | ...

    sessions = relationship("SavedSession", back_populates="owner", cascade="all, delete-orphan")


class SavedSession(Base):
    __tablename__ = "saved_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String, default="Untitled session")
    data = Column(JSON, nullable=False)  # opaque snapshot of frontend session state
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    owner = relationship("User", back_populates="sessions")


# Columns added after the first release. create_all() only creates missing *tables*, never
# missing columns, so a DB built by an earlier version would be missing these and every query
# touching them would fail. Alembic is overkill for a handful of additive columns, so we add
# them by hand at startup. Each entry: (column_name, full DDL type + default).
_ADDITIVE_USER_COLUMNS = [
    ("generations_used", "INTEGER NOT NULL DEFAULT 0"),
    ("video_generations_used", "INTEGER NOT NULL DEFAULT 0"),
    ("is_paid", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("stripe_customer_id", "VARCHAR"),
    ("stripe_subscription_id", "VARCHAR"),
    ("subscription_status", "VARCHAR"),
]


def _add_missing_columns():
    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return  # create_all just made it with every column
    columns = {c["name"]: c for c in inspector.get_columns("users")}
    with engine.begin() as conn:
        for name, ddl in _ADDITIVE_USER_COLUMNS:
            if name in columns:
                continue
            # SQLite spells the boolean default differently to Postgres
            sql = ddl.replace("FALSE", "0") if IS_SQLITE else ddl
            conn.execute(text(f"ALTER TABLE users ADD COLUMN {name} {sql}"))
        # Databases created before Google sign-in still have password_hash NOT NULL.
        # SQLite can't drop a column constraint without a table rebuild — skip there,
        # since local dev DBs are disposable (buddy.db is gitignored).
        pw_col = columns.get("password_hash")
        if pw_col is not None and not pw_col.get("nullable", True) and not IS_SQLITE:
            conn.execute(text("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL"))


def init_db():
    Base.metadata.create_all(bind=engine)
    _add_missing_columns()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
