#!/usr/bin/env node
/**
 * Radar Aspekto Ads — coleta das respostas do formulário
 *
 * Acrescenta a chave `leads` ao `public/data.json` que o fetch-meta.mjs já gravou. É de lá
 * que o bloco de lead score e o de Facebook × Instagram tiram os dados na página publicada.
 *
 * Duas origens possíveis, nesta ordem:
 *
 *   1. RADAR_SHEETS — endereços de planilhas do Google publicadas na web como CSV, um por
 *      linha. É o caminho preferido: não precisa de token nem de conta de serviço, porque o
 *      CSV publicado é lido sem login. Publique uma planilha DERIVADA, que puxa da original
 *      só as colunas sem dado pessoal, por exemplo:
 *
 *          =QUERY('SP Formulário'!A:S; "select B, L, H, M, N, O"; 1)
 *
 *      (data, plataforma, campanha e as três perguntas — nome e telefone ficam de fora).
 *
 *   2. A API da Meta, lendo os cadastros por anúncio. Exige que o token tenha acesso à
 *      Página (leads_retrieval e companhia). Usado quando RADAR_SHEETS não está definida.
 *
 * Variáveis de ambiente
 *   RADAR_SHEETS       endereços CSV publicados, um por linha (ou separados por vírgula)
 *   META_ACCESS_TOKEN  token da Meta, usado só no caminho 2
 *   META_PAGE_ID       id da Página, usado só no caminho 2
 *   META_API_VERSION   versão da Marketing API
 *   RADAR_OUT          arquivo a completar (padrão: public/data.json)
 *
 * DADO PESSOAL NÃO SAI DAQUI. O data.json é público junto com a página, então mesmo lendo
 * uma planilha já derivada o script repete o filtro: só entram campos de múltipla escolha,
 * barrados por uma lista de nomes conhecidos e por uma regra de cardinalidade (campo cujas
 * respostas são quase todas diferentes é texto livre).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeClient, periodRange, isoWithOffset, DEFAULTS } from './fetch-meta.mjs';

/* ---------------------------------------------------------------- privacidade */

const PII = [
  'nome', 'name', 'sobrenome', 'apelido', 'full name', 'first name', 'last name',
  'telefone', 'phone', 'celular', 'whatsapp', 'tel', 'fone',
  'email', 'e mail', 'mail',
  'cpf', 'cnpj', 'rg', 'documento', 'id',
  'endereco', 'address', 'rua', 'numero', 'complemento', 'bairro', 'cep', 'zip', 'post code',
  'cidade', 'city', 'estado', 'state', 'pais', 'country',
  'nascimento', 'birthday', 'dob', 'idade', 'age', 'genero', 'gender', 'sexo',
  'empresa', 'company', 'cargo', 'job title', 'work email',
];

export const norm = (s) => String(s == null ? '' : s)
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

export function looksPersonal(fieldName) {
  const n = norm(fieldName);
  return PII.some((p) => n === p || n.startsWith(p + ' ') || n.endsWith(' ' + p) || n.includes(' ' + p + ' '));
}

/** Campo de múltipla escolha repete poucas respostas; texto livre tem quase uma por pessoa. */
export function pickChoiceFields(records, { maxDistinct = 12, maxRatio = 0.5 } = {}) {
  const seen = new Map();
  for (const r of records) for (const [k, v] of Object.entries(r.answers)) {
    if (!seen.has(k)) seen.set(k, new Set());
    if (v !== '') seen.get(k).add(v);
  }
  const keep = [], dropped = [];
  for (const [field, values] of seen) {
    const distinct = values.size;
    const tooVaried = distinct > maxDistinct || (records.length >= 8 && distinct / records.length > maxRatio);
    (looksPersonal(field) || tooVaried ? dropped : keep).push(field);
  }
  keep.sort(); dropped.sort();
  return { keep, dropped };
}

/* ---------------------------------------------------------------- planilhas publicadas */

/** CSV com aspas, vírgulas e quebras de linha dentro das células. */
export function parseCsv(text, delim = ',') {
  const rows = []; let row = [], cell = '', quoted = false;
  const t = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Aceita o endereço publicado em qualquer forma e devolve a versão que entrega CSV. */
export function csvUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const url = new URL(u);
    if (/\/pub(html)?$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/pub(html)?$/i, '/pub');
    if (!url.searchParams.get('output')) url.searchParams.set('output', 'csv');
    url.searchParams.set('single', 'true');
    return url.toString();
  } catch (e) { return null; }
}

/** As colunas que descrevem o lead; o resto são candidatas a resposta. */
export function mapColumns(header) {
  const h = header.map(norm);
  const find = (re, avoid) => { for (let i = 0; i < h.length; i++) if (re.test(h[i]) && !(avoid && avoid.test(h[i]))) return i; return -1; };
  return {
    date: find(/created|data|hora|timestamp|enviado|submit/),
    platform: find(/platform|plataforma|rede|origem|source/),
    campaign: find(/campaign name|nome da campanha/) >= 0 ? find(/campaign name|nome da campanha/) : find(/campanha|campaign/, /\bid\b/),
  };
}

const toIsoDate = (v) => {
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{2})-(\d{2})-(\d{4})/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
};

const platformOf = (v) => {
  const n = norm(v);
  if (n.includes('instagram') || n === 'ig') return 'ig';
  if (n.includes('facebook') || n === 'fb') return 'fb';
  return 'other';
};

export function parseSheetCsv(text) {
  const nl = text.indexOf('\n'); const first = nl < 0 ? text : text.slice(0, nl);
  const delim = first.split(';').length > first.split(',').length ? ';' : ',';
  const grid = parseCsv(text, delim);
  if (grid.length < 2) return { records: [], header: grid[0] || [], fatal: grid.length ? 'a planilha só tem o cabeçalho' : 'a planilha veio vazia' };
  const header = grid[0].map((x) => String(x).trim());
  const idx = mapColumns(header);
  const records = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]; const get = (j) => (j >= 0 && j < r.length ? r[j] : '');
    const answers = {};
    for (let j = 0; j < header.length; j++) {
      if (j === idx.date || j === idx.platform || j === idx.campaign) continue;
      if (!header[j]) continue;
      answers[header[j]] = norm(get(j)).slice(0, 120);
    }
    records.push({
      date: toIsoDate(get(idx.date)),
      platform: platformOf(get(idx.platform)),
      campaign: String(get(idx.campaign) || ''),
      answers,
    });
  }
  return { records, header, fatal: null };
}

export async function leadsFromSheets({ urls, fetchImpl = globalThis.fetch, log = () => {} }) {
  const records = [], sources = [];
  for (const raw of urls) {
    const url = csvUrl(raw);
    if (!url) { log(`endereço ignorado (não parece um link): ${String(raw).slice(0, 60)}`); continue; }
    const label = 'Planilha ' + (sources.length + 1);
    try {
      const res = await fetchImpl(url, { redirect: 'follow' });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (/^\s*<!DOCTYPE|<html/i.test(body)) {
        throw new Error('o endereço devolveu uma página HTML, não um CSV — confira se a planilha está publicada na web com o formato "Valores separados por vírgula (.csv)"');
      }
      const { records: rows, fatal } = parseSheetCsv(body);
      if (fatal) throw new Error(fatal);
      records.push(...rows);
      sources.push({ id: url.slice(0, 80), name: label, count: rows.length });
      log(`${label}: ${rows.length} linhas`);
    } catch (e) {
      sources.push({ id: url.slice(0, 80), name: label, count: 0, error: e.message });
      log(`${label}: ${e.message}`);
    }
  }
  if (!records.length && sources.every((s) => s.error)) {
    throw new Error('nenhuma planilha pôde ser lida — veja os erros acima');
  }
  return { records, sources };
}

/* ---------------------------------------------------------------- API da Meta (alternativa) */

const LEAD_FIELDS = 'id,created_time,platform,campaign_id,campaign_name,adset_name,ad_name,form_id,field_data';

export function leadRecord(lead, fallbackCampaign = '') {
  const answers = {};
  for (const f of Array.isArray(lead.field_data) ? lead.field_data : []) {
    const name = f && (f.name || f.key);
    if (!name) continue;
    const value = Array.isArray(f.values) ? f.values.join(', ') : String(f.values ?? '');
    answers[String(name)] = norm(value).slice(0, 120);
  }
  return {
    id: String(lead.id || ''),
    date: String(lead.created_time || '').slice(0, 10),
    platform: platformOf(lead.platform),
    campaign: String(lead.campaign_name || fallbackCampaign || ''),
    form: String(lead.form_id || ''),
    answers,
  };
}

const isPermission = (e) => [200, 10, 190, 294, 3].includes(Number(e && e.code));

export function formAds(ads) {
  return (ads || []).filter((a) => /formul[aá]rio|formulario|\[\s*leads?\s*\]|lead ?gen/i.test(String(a.campaign_name || a.name || '')));
}

export async function leadsByAd({ client, ads, filtering, log }) {
  const records = [], seen = new Set();
  let ok = 0, failed = 0, firstError = null, consecutive = 0;
  for (const ad of ads) {
    try {
      const rows = await client.all(`${ad.id}/leads`, { fields: LEAD_FIELDS, filtering, limit: 200 });
      ok++; consecutive = 0;
      for (const row of rows) {
        const r = leadRecord(row, ad.campaign_name);
        if (r.id && seen.has(r.id)) continue;
        if (r.id) seen.add(r.id);
        records.push(r);
      }
    } catch (e) {
      failed++;
      if (!firstError) firstError = e;
      if (isPermission(e)) { consecutive++; if (consecutive >= 3 && ok === 0) return { records: null, error: e }; }
    }
  }
  log(`cadastros por anúncio: ${ok} anúncios lidos, ${failed} com erro, ${records.length} leads`);
  return ok ? { records, error: null } : { records: null, error: firstError };
}

const AJUDA_META = [
  '',
  'O caminho pela API da Meta precisa que o token tenha acesso à Página:',
  '  1. Business Manager → usuário do token → Adicionar ativos → Páginas → Aspekto Saude',
  '  2. Gerar um token NOVO com ads_read, leads_retrieval, pages_show_list,',
  '     pages_read_engagement e pages_manage_ads',
  '  3. Atualizar o segredo META_ACCESS_TOKEN no GitHub',
  '',
  'Ou, mais simples, defina a variável RADAR_SHEETS com o endereço CSV de uma planilha',
  'derivada publicada na web (sem as colunas de nome e telefone).',
].join('\n');

/* ---------------------------------------------------------------- montagem */

export function buildLeads({ records, sources, range, via, now = new Date(), log = () => {} }) {
  const inRange = records.filter((r) => r.date && r.date >= range.since && r.date <= range.until);
  log(`leads no período ${range.since} a ${range.until}: ${inRange.length} (de ${records.length} lidos)`);

  const { keep, dropped } = pickChoiceFields(inRange);
  log(`campos publicados: ${keep.length} · descartados por serem pessoais ou de texto livre: ${dropped.length}`);
  if (!keep.length && inRange.length) log('ATENÇÃO: nenhum campo de múltipla escolha sobrou — o lead score vai ficar vazio na página.');

  const campaigns = [], idxOf = new Map();
  const rows = inRange.map((r) => {
    if (!idxOf.has(r.campaign)) { idxOf.set(r.campaign, campaigns.length); campaigns.push(r.campaign); }
    return [r.date, r.platform, idxOf.get(r.campaign), keep.map((f) => r.answers[f] ?? '')];
  });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return {
    generatedAt: isoWithOffset(now, DEFAULTS.timezone),
    via,
    since: range.since, until: range.until,
    total: rows.length,
    forms: sources,
    fields: keep,
    dropped,
    campaigns,
    rows,
  };
}

export function sheetUrls(value) {
  return String(value || '').split(/[\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

/* ---------------------------------------------------------------- execução */

async function main() {
  const out = process.env.RADAR_OUT || DEFAULTS.out;
  const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

  let data;
  try {
    data = JSON.parse(await readFile(out, 'utf8'));
  } catch (e) {
    console.error(`Não consegui ler ${out}: ${e.message}. Rode o scripts/fetch-meta.mjs antes deste.`);
    process.exit(2);
  }
  const range = data.range && data.range.since ? data.range : periodRange(new Date(), DEFAULTS.timezone);

  const urls = sheetUrls(process.env.RADAR_SHEETS);
  if (urls.length) {
    log(`lendo ${urls.length} planilha(s) publicada(s)`);
    const { records, sources } = await leadsFromSheets({ urls, log });
    data.leads = buildLeads({ records, sources, range, via: 'planilhas', log });
  } else {
    const token = process.env.META_ACCESS_TOKEN;
    if (!token) { console.error('Defina RADAR_SHEETS (planilha publicada) ou META_ACCESS_TOKEN.'); process.exit(2); }
    const version = process.env.META_API_VERSION || DEFAULTS.version;
    const client = makeClient({ token, version, log }); client.version = version;
    const sinceUnix = Math.floor(new Date(range.since + 'T00:00:00-03:00').getTime() / 1000);
    const filtering = [{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }];
    const ads = formAds(data.ads);
    log(`anúncios de campanhas de formulário: ${ads.length} de ${(data.ads || []).length}`);
    const { records, error } = await leadsByAd({ client, ads, filtering, log });
    if (!records) throw new Error((error ? error.message : 'nenhum cadastro lido') + '\n' + AJUDA_META);
    data.leads = buildLeads({ records, sources: [], range, via: 'meta', log });
  }

  await writeFile(out, JSON.stringify(data));
  const l = data.leads;
  log(`gravado ${out} · ${l.total} leads (via ${l.via}) · campos: ${l.fields.join(' | ') || '(nenhum)'}`);
  if (l.dropped.length) log(`campos descartados (não vão para a web): ${l.dropped.join(' | ')}`);
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
