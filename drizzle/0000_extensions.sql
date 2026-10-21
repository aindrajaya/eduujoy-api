-- pgvector lives in the public schema (PRD-API §12) so per-run test schemas resolve `vector` via search_path.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
