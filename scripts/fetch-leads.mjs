#!/usr/bin/env node
/**
 * Radar Aspekto Ads — coleta das respostas do formulário
 *
 * Acrescenta a chave `leads` ao `public/data.json` que o fetch-meta.mjs já gravou. É de lá
 * que o bloco de lead score e o de Facebook × Instagram tiram os dados na página publicada —
 * no painel do Claude esses mesmos números vêm das planilhas do Google.
 *
 *   META_ACCESS_TOKEN=xxx node scripts/fetch-leads.mjs
 *
 * Caminho preferido: os cadastros são lidos **por anúncio** (`/{ad-id}/leads`), usando os ids
 * que o fetch-meta.mjs já gravou. Assim não é preciso listar os formulários da Página, que é
 * o que exige a permissão `pages_manage_ads`. Se esse caminho for negado, o script tenta o
 * caminho pela Página e, se também falhar, explica no log exatamente o que falta no token.
 *
 * Variáveis de ambiente
 *   META_ACCESS_TOKEN  (obrigatória) token com ads_read e leads_retrieval
 *   META_PAGE_ID       id da Página, usado só no caminho alternativo
 *   META_API_VERSION   versão da Marketing API (padrão: a do fetch-meta.mjs)
 *   RADAR_OUT          arquivo a completar (padrão: public/data.json)
 *
 * DADO PESSOAL NÃO SAI DAQUI. O data.json é público junto com a página, então só entram os
 * campos de múltipla escolha do formulário. Nome, telefone, e-mail e qualquer texto livre são
 * descartados por duas barreiras independentes: uma lista de nomes de campo conhecidos e uma
 * regra de cardinalidade (campo cujas respostas são quase todas diferentes é texto livre).
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
 * Segunda barreira: um campo de múltipla escolha repete as mesmas poucas respostas entre os
 * leads; um campo de texto livre tem quase uma resposta diferente por pessoa.
 */
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

/* ---------------------------------------------------------------- leitura na Meta */

const platformOf = (v) => {
  const n = norm(v);
  if (n.includes('instagram') || n === 'ig') return 'ig';
  if (n.includes('facebook') || n === 'fb') return 'fb';
  return 'other';
};

const LEAD_FIELDS = 'id,created_time,platform,campaign_id,campaign_name,adset_name,ad_name,form_id,field_data';

/** Um lead da API vira { id, date, platform, campaign, form, answers: { campo: resposta } }. */
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

/** Um erro de permissão vale trocar de caminho; um erro pontual de um anúncio, não. */
const isPermission = (e) => [200, 10, 190, 294, 3].includes(Number(e && e.code));

/** Só os anúncios de campanhas de formulário — os outros não têm cadastro para buscar. */
export function formAds(ads) {
  return (ads || []).filter((a) => /formul[aá]rio|formulario|\[\s*leads?\s*\]|lead ?gen/i.test(String(a.campaign_name || a.name || '')));
}

/** Caminho preferido: cadastros por anúncio, com os ids que já temos. */
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
      if (isPermission(e)) {
        consecutive++;
        // três negativas seguidas logo de cara: é permissão, não azar — não adianta insistir
        if (consecutive >= 3 && ok === 0) {
          log(`cadastros por anúncio negados (${e.message.slice(0, 120)}…) — tentando pela Página`);
          return { records: null, error: e };
        }
      }
    }
  }
  log(`cadastros por anúncio: ${ok} anúncios lidos, ${failed} com erro, ${records.length} leads`);
  if (!ok) return { records: null, error: firstError };
  return { records, error: null, ok, failed };
}

/** Caminho alternativo: listar os formulários da Página. Exige mais permissões. */
export async function leadsByPage({ client, pageId, version, filtering, log }) {
  if (!pageId) throw new Error('sem META_PAGE_ID para tentar o caminho pela Página');
  let pc = client;
  try {
    const r = await client.call(String(pageId), { fields: 'access_token,name' });
    if (r && r.access_token) { pc = makeClient({ token: r.access_token, version, log }); pc.version = version; log('usando o token da própria Página'); }
  } catch (e) { log(`sem token de Página (${e.message.slice(0, 100)}…) — seguindo com o token atual`); }

  const forms = await pc.all(`${pageId}/leadgen_forms`, { fields: 'id,name,status' });
  log(`formulários na página: ${forms.length}`);
  const records = [], forminfo = [];
  for (const form of forms) {
    try {
      const rows = await pc.all(`${form.id}/leads`, { fields: LEAD_FIELDS, filtering, limit: 200 });
      records.push(...rows.map((r) => leadRecord(r)));
      forminfo.push({ id: String(form.id), name: form.name || '', count: rows.length });
    } catch (e) {
      forminfo.push({ id: String(form.id), name: form.name || '', count: 0, error: e.message });
      log(`formulário "${form.name}": ${e.message}`);
    }
  }
  return { records, forminfo };
}

const AJUDA = [
  '',
  'Nenhum dos dois caminhos de leitura de cadastros foi autorizado.',
  'No Business Manager, no usuário dono do token:',
  '  1. Adicionar ativos → Páginas → Aspekto Saude, com acesso aos cadastros',
  '  2. Gerar um token NOVO (um token já emitido não ganha permissões) marcando',
  '     ads_read, leads_retrieval, pages_show_list, pages_read_engagement e pages_manage_ads',
  '  3. Atualizar o segredo META_ACCESS_TOKEN no GitHub',
].join('\n');

export async function collectLeads({ client, ads, pageId, range, version = DEFAULTS.version, now = new Date(), log = () => {} }) {
  const sinceUnix = Math.floor(new Date(range.since + 'T00:00:00-03:00').getTime() / 1000);
  const filtering = [{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }];

  const candidates = formAds(ads);
  log(`anúncios de campanhas de formulário: ${candidates.length} de ${(ads || []).length}`);

  let records = null, forminfo = [], via = 'anuncios';
  if (candidates.length) {
    const r = await leadsByAd({ client, ads: candidates, filtering, log });
    records = r.records;
  }
  if (!records) {
    via = 'pagina';
    try {
      const r = await leadsByPage({ client, pageId, version, filtering, log });
      records = r.records; forminfo = r.forminfo;
    } catch (e) {
      throw new Error(e.message + '\n' + AJUDA);
    }
  }
  if (!records) throw new Error('não consegui ler cadastro nenhum.' + '\n' + AJUDA);

  const inRange = records.filter((r) => r.date && r.date >= range.since && r.date <= range.until);
  log(`leads no período ${range.since} a ${range.until}: ${inRange.length} (de ${records.length} lidos)`);

  const { keep, dropped } = pickChoiceFields(inRange);
  log(`campos publicados: ${keep.length} · descartados por serem pessoais ou de texto livre: ${dropped.length}`);
  if (!keep.length && inRange.length) log('ATENÇÃO: nenhum campo de múltipla escolha sobrou — o lead score vai ficar vazio na página.');

  // agrupa por formulário só para o painel mostrar de onde vieram
  if (!forminfo.length) {
    const byForm = new Map();
    for (const r of inRange) byForm.set(r.form, (byForm.get(r.form) || 0) + 1);
    forminfo = [...byForm].map(([id, count]) => ({ id, name: 'Formulário ' + id, count }));
  }

  // nomes de campanha repetem muito: guardamos uma vez e referenciamos por índice
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
    forms: forminfo,
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
  const version = process.env.META_API_VERSION || DEFAULTS.version;
  const pageId = String(process.env.META_PAGE_ID || '').replace(/\D/g, '');
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

  data.leads = await collectLeads({ client, ads: data.ads, pageId, range, version, log });
  await writeFile(out, JSON.stringify(data));

  const l = data.leads;
  log(`gravado ${out} · ${l.total} leads (via ${l.via}) · campos: ${l.fields.join(' | ') || '(nenhum)'}`);
  if (l.dropped.length) log(`campos descartados (não vão para a web): ${l.dropped.join(' | ')}`);
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
