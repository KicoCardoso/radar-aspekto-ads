#!/usr/bin/env node
/**
 * Radar Aspekto Ads — coleta das respostas do formulário
 *
 * Lê os formulários de cadastro da Página na Marketing API da Meta e acrescenta a chave
 * `leads` ao `public/data.json` que o fetch-meta.mjs já gravou. É de lá que o bloco de
 * lead score e o de Facebook × Instagram tiram os dados na página publicada — no painel
 * do claude.ai esses mesmos números vêm das planilhas do Google.
 *
 *   META_ACCESS_TOKEN=xxx META_PAGE_ID=1155805810953446 node scripts/fetch-leads.mjs
 *
 * Variáveis de ambiente
 *   META_ACCESS_TOKEN  (obrigatória) token do usuário do sistema com ads_read,
 *                      leads_retrieval, pages_show_list e pages_read_engagement
 *   META_PAGE_ID       (obrigatória) id da Página dona dos formulários
 *   META_API_VERSION   versão da Marketing API (padrão: a do fetch-meta.mjs)
 *   RADAR_OUT          arquivo a completar (padrão: public/data.json)
 *
 * DADO PESSOAL NÃO SAI DAQUI. Só entram no arquivo os campos de múltipla escolha do
 * formulário: nome, telefone, e-mail e qualquer campo de texto livre são descartados
 * por duas barreiras independentes — uma lista de nomes conhecidos e uma regra de
 * cardinalidade (campo cujas respostas são quase todas diferentes é texto livre).
 * O que é gravado por lead: data, plataforma, campanha e as respostas escolhidas.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeClient, periodRange, isoWithOffset, DEFAULTS } from './fetch-meta.mjs';

/* ---------------------------------------------------------------- privacidade */

// Primeira barreira: nomes de campo que nunca entram, mesmo que pareçam de baixa variedade.
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

const norm = (s) => String(s == null ? '' : s)
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

export function looksPersonal(fieldName) {
  const n = norm(fieldName);
  return PII.some((p) => n === p || n.startsWith(p + ' ') || n.endsWith(' ' + p) || n.includes(' ' + p + ' '));
}

/**
 * Segunda barreira: um campo de múltipla escolha repete as mesmas poucas respostas entre
 * os leads; um campo de texto livre tem quase uma resposta diferente por pessoa. Devolve
 * os campos que podem ser publicados.
 */
export function pickChoiceFields(records, { maxDistinct = 12, maxRatio = 0.5 } = {}) {
  const seen = new Map(); // campo -> Set de respostas
  for (const r of records) for (const [k, v] of Object.entries(r.answers)) {
    if (!seen.has(k)) seen.set(k, new Set());
    if (v !== '') seen.get(k).add(v);
  }
  const keep = [], dropped = [];
  for (const [field, values] of seen) {
    const distinct = values.size;
    const personal = looksPersonal(field);
    const tooVaried = distinct > maxDistinct || (records.length >= 8 && distinct / records.length > maxRatio);
    (personal || tooVaried ? dropped : keep).push(field);
  }
  keep.sort(); dropped.sort();
  return { keep, dropped };
}

/* ---------------------------------------------------------------- leitura na Meta */

const platformOf = (v) => {
  const n = norm(v);
  if (n.includes('instagram') || n === 'ig') return 'ig';
  if (n.includes('facebook') || n === 'fb') return 'fb';
  return 'other';
};

/** Um lead da API vira { date, platform, campaign, answers: { campo: resposta } }. */
export function leadRecord(lead) {
  const answers = {};
  for (const f of Array.isArray(lead.field_data) ? lead.field_data : []) {
    const name = f && (f.name || f.key);
    if (!name) continue;
    const value = Array.isArray(f.values) ? f.values.join(', ') : String(f.values ?? '');
    answers[String(name)] = norm(value).slice(0, 120);
  }
  return {
    date: String(lead.created_time || '').slice(0, 10),
    platform: platformOf(lead.platform),
    campaign: String(lead.campaign_name || ''),
    answers,
  };
}

/**
 * A retirada de cadastros normalmente exige um token da própria Página. Com o usuário do
 * sistema dono da Página, a Graph API devolve esse token aqui; se não devolver, seguimos
 * com o token original (funciona quando ele já é um token de Página).
 */
export async function pageClient({ client, pageId, version, log }) {
  try {
    const r = await client.call(String(pageId), { fields: 'access_token,name' });
    if (r && r.access_token) {
      log(`página "${r.name || pageId}": usando o token da própria página`);
      const c = makeClient({ token: r.access_token, version, log });
      c.version = version;
      return { client: c, name: r.name || String(pageId) };
    }
    return { client, name: (r && r.name) || String(pageId) };
  } catch (e) {
    log(`não consegui o token da página (${e.message}) — seguindo com o token do usuário do sistema`);
    return { client, name: String(pageId) };
  }
}

export async function collectLeads({ client, pageId, range, version = DEFAULTS.version, now = new Date(), log = () => {} }) {
  const { client: pc, name: pageName } = await pageClient({ client, pageId, version, log });

  const forms = await pc.all(`${pageId}/leadgen_forms`, { fields: 'id,name,status' });
  log(`formulários na página: ${forms.length}`);
  if (!forms.length) throw new Error('A página não devolveu nenhum formulário de cadastro. Confira se o usuário do sistema tem a Página atribuída com acesso aos cadastros e se o token tem leads_retrieval.');

  // só o período que a página mostra; a Meta filtra pelo instante de criação (epoch em segundos)
  const sinceUnix = Math.floor(new Date(range.since + 'T00:00:00-03:00').getTime() / 1000);
  const filtering = [{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }];
  const fields = 'id,created_time,platform,campaign_id,campaign_name,adset_name,ad_name,field_data';

  const records = [], formInfo = [];
  for (const form of forms) {
    let rows = [];
    try {
      rows = await pc.all(`${form.id}/leads`, { fields, filtering, limit: 200 });
    } catch (e) {
      log(`formulário "${form.name}" (${form.id}): ${e.message}`);
      formInfo.push({ id: String(form.id), name: form.name || '', count: 0, error: e.message });
      continue;
    }
    const kept = rows
      .map(leadRecord)
      .filter((r) => r.date && r.date >= range.since && r.date <= range.until);
    records.push(...kept);
    formInfo.push({ id: String(form.id), name: form.name || '', count: kept.length });
    log(`formulário "${form.name}": ${kept.length} leads no período (de ${rows.length} lidos)`);
  }

  const { keep, dropped } = pickChoiceFields(records);
  log(`campos publicados: ${keep.length} · descartados por serem pessoais ou de texto livre: ${dropped.length}`);
  if (!keep.length && records.length) log('ATENÇÃO: nenhum campo de múltipla escolha sobrou — o lead score vai ficar vazio na página.');

  // nomes de campanha repetem muito: guardamos uma vez e referenciamos por índice
  const campaigns = [], idxOf = new Map();
  const rows = records.map((r) => {
    if (!idxOf.has(r.campaign)) { idxOf.set(r.campaign, campaigns.length); campaigns.push(r.campaign); }
    return [r.date, r.platform, idxOf.get(r.campaign), keep.map((f) => r.answers[f] ?? '')];
  });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return {
    generatedAt: isoWithOffset(now, DEFAULTS.timezone),
    page: { id: String(pageId), name: pageName },
    since: range.since, until: range.until,
    total: rows.length,
    forms: formInfo,
    fields: keep,
    dropped,
    campaigns,
    rows,
  };
}

/* ---------------------------------------------------------------- execução */

async function main() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) { console.error('Falta a variável META_ACCESS_TOKEN.'); process.exit(2); }
  const pageId = String(process.env.META_PAGE_ID || '').replace(/\D/g, '');
  if (!pageId) { console.error('Falta a variável META_PAGE_ID (o id da Página dona dos formulários).'); process.exit(2); }
  const version = process.env.META_API_VERSION || DEFAULTS.version;
  const out = process.env.RADAR_OUT || DEFAULTS.out;
  const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

  let data;
  try {
    data = JSON.parse(await readFile(out, 'utf8'));
  } catch (e) {
    console.error(`Não consegui ler ${out}: ${e.message}. Rode o scripts/fetch-meta.mjs antes deste.`);
    process.exit(2);
  }

  const client = makeClient({ token, version, log });
  client.version = version;
  const range = data.range && data.range.since ? data.range : periodRange(new Date(), DEFAULTS.timezone);

  data.leads = await collectLeads({ client, pageId, range, version, log });
  await writeFile(out, JSON.stringify(data));

  const l = data.leads;
  log(`gravado ${out} · ${l.total} leads · campos: ${l.fields.join(' | ') || '(nenhum)'}`);
  if (l.dropped.length) log(`campos descartados (não vão para a web): ${l.dropped.join(' | ')}`);
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
