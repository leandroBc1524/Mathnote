// ════════════════════════════════════════════════
// processor.js — Worker del Pipeline
// Corre en tu máquina o servidor con Node.js
//
// SETUP:
//   npm install groq-sdk @supabase/supabase-js node-fetch
//   node processor.js
// ════════════════════════════════════════════════

import Groq from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// ⚠️ CONFIGURA AQUÍ
const GROQ_API_KEY   = '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';
const SUPABASE_URL   = 'https://mpzsjetipddryqfzafhd.supabase.co';
const SUPABASE_KEY   = 'sb_secret_TuDmHhHcNP0d77kcdVQibA_ACigRaSL';
// ════════════════════

const groq    = new Groq({ apiKey: GROQ_API_KEY });
const db      = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── CONTRATO ESTRICTO CON LA IA ─────────────────
// temperature = 0. Sin creatividad. Solo JSON.
const SYSTEM_PROMPT = `Eres un extractor de preguntas de opción múltiple.
Tu única función es convertir texto en JSON estructurado.

REGLAS ABSOLUTAS:
1. Devuelves ÚNICAMENTE un arreglo JSON. Sin texto adicional. Sin markdown. Sin explicaciones.
2. Cada objeto tiene EXACTAMENTE estos campos (ni uno más, ni uno menos):
   pregunta, opcion_a, opcion_b, opcion_c, opcion_d, respuesta_correcta, explicacion, area, tema, dificultad, universidad, anio
3. respuesta_correcta: SOLO "A", "B", "C" o "D"
4. area: SOLO uno de estos valores exactos: Matematica | Fisica | Quimica | Biologia | Historia | Lenguaje
5. dificultad: entero del 1 al 5. Sin comillas.
6. universidad: string si aparece en el texto, null si no.
7. anio: entero si aparece, null si no.
8. No inventes preguntas. Solo extrae las que están en el texto.
9. Si no hay preguntas en el texto, devuelve: []

FORMATO EXACTO (sin variaciones):
[{"pregunta":"","opcion_a":"","opcion_b":"","opcion_c":"","opcion_d":"","respuesta_correcta":"A","explicacion":"","area":"Matematica","tema":"","dificultad":3,"universidad":null,"anio":null}]`;

const AREAS_VALIDAS = new Set(['Matematica','Fisica','Quimica','Biologia','Historia','Lenguaje']);
const RESP_VALIDAS  = new Set(['A','B','C','D']);

// ─── VALIDADOR — el backend nunca confía en la IA
function validate(q) {
  const errors = [];

  if (!q.pregunta?.trim() || q.pregunta.trim().length < 8)
    errors.push('pregunta vacía o muy corta');

  const opts = ['opcion_a','opcion_b','opcion_c','opcion_d'];
  for (const k of opts) {
    if (!q[k]?.trim()) errors.push(`${k} vacía`);
  }

  const vals = opts.map(k => q[k]?.trim().toLowerCase()).filter(Boolean);
  if (new Set(vals).size !== vals.length)
    errors.push('opciones duplicadas');

  if (!RESP_VALIDAS.has(q.respuesta_correcta))
    errors.push(`respuesta_correcta inválida: "${q.respuesta_correcta}"`);

  if (!AREAS_VALIDAS.has(q.area))
    errors.push(`area inválida: "${q.area}"`);

  if (!Number.isInteger(q.dificultad) || q.dificultad < 1 || q.dificultad > 5)
    errors.push('dificultad debe ser entero 1-5');

  if (!q.explicacion?.trim())
    errors.push('explicacion vacía');

  if (!q.tema?.trim())
    errors.push('tema vacío');

  return { valida: errors.length === 0, error: errors.join(' | ') || null };
}

// ─── PARSEO DEFENSIVO ─────────────────────────────
// La IA a veces manda markdown aunque le digas que no.
function parseIA(raw) {
  // Limpiar posibles fences markdown
  const cleaned = raw
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/```\s*$/m, '')
    .trim();

  // Intento 1: parse directo
  try {
    const p = JSON.parse(cleaned);
    return Array.isArray(p) ? p : [];
  } catch { /* sigue */ }

  // Intento 2: encontrar el primer array JSON en la respuesta
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const p = JSON.parse(match[0]);
      return Array.isArray(p) ? p : [];
    } catch { /* sigue */ }
  }

  // Intento 3: buscar objetos individuales y armar array
  const objMatches = [...cleaned.matchAll(/\{[^{}]+\}/g)];
  if (objMatches.length) {
    try {
      return objMatches.map(m => JSON.parse(m[0])).filter(Boolean);
    } catch { /* sigue */ }
  }

  console.log('  ⚠ No se pudo parsear respuesta de Groq');
  return [];
}

// ─── EXTRAER TEXTO DEL PDF ────────────────────────
// Usa pdfjs-dist (sin browser). Si tienes problemas, instala:
// npm install pdfjs-dist
async function extractText(storageUrl) {
  // Descargar el PDF
  const res    = await fetch(storageUrl);
  const buffer = await res.arrayBuffer();

  // Usar pdfjs
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf      = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages    = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text    = content.items.map(item => item.str).join(' ');
    pages.push(text);
  }

  return { text: pages.join('\n\n'), numPages: pdf.numPages };
}

// ─── DIVIDIR POR BLOQUES DE PREGUNTAS ────────────
// Busca números al inicio de línea: "1.", "2)", "Pregunta 1", etc.
// Agrupa en batches de N preguntas para Groq.
function chunkByQuestions(text, batchSize = 10) {
  const lines    = text.split('\n');
  const chunks   = [];
  let   current  = [];
  let   qCount   = 0;
  const qPattern = /^\s*(\d{1,3}[.):\-]|Pregunta\s+\d+|Ítem\s+\d+)/i;

  for (const line of lines) {
    if (qPattern.test(line)) {
      qCount++;
      if (qCount > batchSize && current.length > 0) {
        chunks.push(current.join('\n'));
        current = [];
        qCount  = 1;
      }
    }
    current.push(line);
  }

  if (current.length > 0) chunks.push(current.join('\n'));

  // Si no detectó numeración, divide por tamaño fijo de palabras
  if (chunks.length <= 1 && text.split(/\s+/).length > 3000) {
    console.log('  ℹ️ Sin numeración detectada — dividiendo por tamaño');
    const words = text.split(/\s+/);
    const size  = 2500;
    for (let i = 0; i < words.length; i += size) {
      chunks.push(words.slice(i, i + size).join(' '));
    }
  }

  return chunks.filter(c => c.trim().length > 50);
}

// ─── LLAMAR A GROQ ────────────────────────────────
async function callGroq(chunk) {
  const response = await groq.chat.completions.create({
    model:       'llama-3.3-70b-versatile',
    temperature: 0,        // sin creatividad
    max_tokens:  4096,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: chunk },
    ],
  });

  const raw = response.choices[0].message.content;
  return parseIA(raw);
}

// ─── GUARDAR EN DRAFT ─────────────────────────────
async function saveDraft(jobId, questions, simulacroId) {
  if (!questions.length) return { total: 0, validas: 0 };

  const rows = questions.map(q => {
    const { valida, error } = validate(q);
    return {
      job_id:            jobId,
      pregunta:          q.pregunta?.trim()        || null,
      opcion_a:          q.opcion_a?.trim()         || null,
      opcion_b:          q.opcion_b?.trim()         || null,
      opcion_c:          q.opcion_c?.trim()         || null,
      opcion_d:          q.opcion_d?.trim()         || null,
      respuesta_correcta: RESP_VALIDAS.has(q.respuesta_correcta) ? q.respuesta_correcta : null,
      explicacion:       q.explicacion?.trim()      || null,
      area:              AREAS_VALIDAS.has(q.area) ? q.area : null,
      tema:              q.tema?.trim()             || null,
      dificultad:        (Number.isInteger(q.dificultad) && q.dificultad >= 1 && q.dificultad <= 5) ? q.dificultad : null,
      universidad:       q.universidad              || null,
      anio:              Number.isInteger(q.anio) ? q.anio : null,
      simulacro_id:      simulacroId               || null,
      valida,
      error_msg:         error,
    };
  });

  // Insertar en lotes de 50
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await db.from('preguntas_draft').insert(rows.slice(i, i + BATCH));
    if (error) throw new Error('Error guardando draft: ' + error.message);
  }

  const validas = rows.filter(r => r.valida).length;
  return { total: rows.length, validas };
}

// ─── ACTUALIZAR ESTADO DEL JOB ───────────────────
async function updateJob(jobId, fields) {
  const { error } = await db.from('pdf_jobs')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) console.error('  ⚠ updateJob error:', error.message);
}

// ─── TOMAR SIGUIENTE JOB (lock optimista) ─────────
async function takeNextJob() {
  const { data: jobs } = await db
    .from('pdf_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);

  if (!jobs?.length) return null;
  const job = jobs[0];

  // Intentar marcar como "extracting" atomicamente
  const { data: locked, error } = await db
    .from('pdf_jobs')
    .update({ status: 'extracting', updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'pending')  // condición: que siga en pending
    .select();

  // Si otro worker tomó el job primero, locked será vacío
  if (error || !locked?.length) return null;
  return job;
}

// ─── OBTENER URL PÚBLICA DEL ARCHIVO ─────────────
function getPublicUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${storagePath}`;
}

// ─── MAIN LOOP ─────────────────────────────────────
async function run() {
  console.log('═'.repeat(50));
  console.log('  🚀 Worker iniciado');
  console.log('  Modelo: llama-3.3-70b-versatile (temperature=0)');
  console.log('  Chequeando jobs cada 5 segundos...');
  console.log('═'.repeat(50));

  while (true) {
    try {
      const job = await takeNextJob();

      if (!job) {
        process.stdout.write('.');
        await sleep(5000);
        continue;
      }

      console.log('\n' + '─'.repeat(50));
      console.log(`📄 Job: ${job.filename}`);
      console.log(`   Tipo: ${job.tipo} | ID: ${job.id}`);

      // ── 1. Extraer texto ──
      await updateJob(job.id, { status: 'extracting' });
      console.log('  📖 Extrayendo texto del PDF...');

      const publicUrl = getPublicUrl(job.storage_path);
      const { text, numPages } = await extractText(publicUrl);
      await updateJob(job.id, { pages: numPages });
      console.log(`  ✓ ${numPages} páginas extraídas (${text.split(/\s+/).length.toLocaleString()} palabras)`);

      // ── 2. Dividir en chunks ──
      const chunks = chunkByQuestions(text, 10);
      console.log(`  📦 ${chunks.length} bloques de preguntas`);

      // ── 3. Procesar con Groq ──
      await updateJob(job.id, { status: 'ai_processing' });
      const allQuestions = [];

      for (let i = 0; i < chunks.length; i++) {
        process.stdout.write(`  ⚡ Bloque ${i+1}/${chunks.length}... `);
        try {
          const qs = await callGroq(chunks[i]);
          allQuestions.push(...qs);
          console.log(`${qs.length} preguntas`);
        } catch (err) {
          console.log(`ERROR: ${err.message}`);
        }
        // Rate limit: Groq free tier = ~30 req/min
        if (i < chunks.length - 1) await sleep(2000);
      }

      console.log(`  📊 Total extraído: ${allQuestions.length} preguntas`);

      // ── 4. Validar y guardar draft ──
      await updateJob(job.id, { status: 'validating' });
      console.log('  ✅ Validando y guardando en draft...');

      const { total, validas } = await saveDraft(job.id, allQuestions, job.simulacro_id);

      // ── 5. Marcar como draft (listo para revisión) ──
      await updateJob(job.id, { status: 'draft', total_draft: total, validas });

      console.log(`  ✓ COMPLETADO: ${validas}/${total} preguntas válidas en draft`);
      console.log('  → Ve al panel admin > Revisar Draft para aprobarlas');

    } catch (err) {
      console.error('\n❌ Error en loop principal:', err.message);
      await sleep(10000);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
run();
