-- ================================================
-- SCHEMA — Plataforma de estudio
-- Pega esto en Supabase > SQL Editor > Run
-- ================================================

-- Áreas como tipo (la DB rechaza cualquier otro valor)
CREATE TYPE area_enum AS ENUM (
  'Matematica','Fisica','Quimica',
  'Biologia','Historia','Lenguaje'
);

-- ─── SIMULACROS ────────────────────────────────
CREATE TABLE simulacros (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        TEXT NOT NULL,
  universidad   TEXT,
  anio          INT,
  tiempo_limite INT,  -- minutos
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── MÓDULOS (camino progresivo) ───────────────
CREATE TABLE modulos (
  id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  area   area_enum NOT NULL,
  tema   TEXT NOT NULL,
  orden  INT NOT NULL,
  UNIQUE(area, orden)
);

-- Módulos base (puedes agregar más)
INSERT INTO modulos (area, tema, orden) VALUES
  ('Matematica', 'Algebra',          1),
  ('Matematica', 'Geometria',        2),
  ('Matematica', 'Trigonometria',    3),
  ('Matematica', 'Calculo',          4),
  ('Fisica',     'Cinematica',       1),
  ('Fisica',     'Dinamica',         2),
  ('Fisica',     'Energia',          3),
  ('Quimica',    'Tabla Periodica',  1),
  ('Quimica',    'Enlace Quimico',   2),
  ('Quimica',    'Estequiometria',   3),
  ('Biologia',   'Celula',           1),
  ('Biologia',   'Genetica',         2),
  ('Historia',   'Peru Colonial',    1),
  ('Historia',   'Peru Republicano', 2),
  ('Lenguaje',   'Comprension',      1),
  ('Lenguaje',   'Gramatica',        2);

-- ─── PREGUNTAS — NÚCLEO ABSOLUTO ───────────────
CREATE TABLE preguntas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pregunta           TEXT NOT NULL,
  opcion_a           TEXT NOT NULL,
  opcion_b           TEXT NOT NULL,
  opcion_c           TEXT NOT NULL,
  opcion_d           TEXT NOT NULL,
  respuesta_correcta CHAR(1) NOT NULL CHECK (respuesta_correcta IN ('A','B','C','D')),
  explicacion        TEXT NOT NULL,
  area               area_enum NOT NULL,
  tema               TEXT NOT NULL,
  dificultad         INT NOT NULL CHECK (dificultad BETWEEN 1 AND 5),
  universidad        TEXT,
  anio               INT,
  simulacro_id       UUID REFERENCES simulacros(id),
  modulo_id          UUID REFERENCES modulos(id),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ─── DRAFT (preguntas sin aprobar aún) ─────────
CREATE TABLE preguntas_draft (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             TEXT NOT NULL,
  pregunta           TEXT,
  opcion_a           TEXT,
  opcion_b           TEXT,
  opcion_c           TEXT,
  opcion_d           TEXT,
  respuesta_correcta CHAR(1),
  explicacion        TEXT,
  area               TEXT,   -- TEXT aquí porque Groq puede mandar basura
  tema               TEXT,
  dificultad         INT,
  universidad        TEXT,
  anio               INT,
  simulacro_id       UUID REFERENCES simulacros(id),
  valida             BOOLEAN DEFAULT FALSE,
  error_msg          TEXT,
  aprobada           BOOLEAN,  -- NULL=pendiente, TRUE=publicada, FALSE=rechazada
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ─── JOBS ──────────────────────────────────────
CREATE TABLE pdf_jobs (
  id           TEXT PRIMARY KEY,  -- timestamp_filename
  filename     TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  tipo         TEXT NOT NULL DEFAULT 'banco' CHECK (tipo IN ('banco','simulacro')),
  universidad  TEXT,
  anio         INT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                 'pending','extracting','ai_processing',
                 'validating','draft','done','error')),
  simulacro_id UUID REFERENCES simulacros(id),
  total_draft  INT DEFAULT 0,
  validas      INT DEFAULT 0,
  error_msg    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── ÍNDICES ───────────────────────────────────
CREATE INDEX ON preguntas(area);
CREATE INDEX ON preguntas(simulacro_id);
CREATE INDEX ON preguntas(modulo_id);
CREATE INDEX ON preguntas(dificultad);
CREATE INDEX ON preguntas(area, dificultad);
CREATE INDEX ON preguntas_draft(job_id);
CREATE INDEX ON preguntas_draft(aprobada);
CREATE INDEX ON pdf_jobs(status);

-- ─── RLS: solo tú puedes escribir ─────────────
-- Activa Row Level Security en Supabase dashboard
-- para las tablas: preguntas, preguntas_draft, pdf_jobs, simulacros
-- Política de lectura pública para preguntas (los alumnos leen):
ALTER TABLE preguntas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Lectura publica" ON preguntas FOR SELECT USING (true);
-- Las demás políticas las configuras en el dashboard con tu service_key
