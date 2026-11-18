-- ベクトル検索(pgvector)の拡張機能を有効にする。
-- ローカル(Docker)と本番(Neon)の両方で、マイグレーションだけで同じ状態になるようにする。
CREATE EXTENSION IF NOT EXISTS vector;
