-- Trigram similarity for the topic-resolve fallback when embeddings are unavailable (contract 0.4.0-v0).
-- Like pgvector it lives in public, so per-run test schemas resolve similarity() via search_path.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
