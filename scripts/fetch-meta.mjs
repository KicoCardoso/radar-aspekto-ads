#!/usr/bin/env node
/**
 * Radar Aspekto Ads — coleta de dados
 *
 * Lê a conta de anúncios na Marketing API da Meta e grava `public/data.json`, o arquivo
 * que a página `public/index.html` carrega. Roda no GitHub Actions (ver
 * .github/workflows/atualizar.yml), mas também funciona no seu computador:
 *
 *   META_ACCESS_TOKEN=xxx node scripts/fetch-meta.mjs
 *
 * Variáveis de ambiente
 *   META_ACCESS_TOKEN   (obrigatória) token de usuário do sistema com permissão ads_read
 *   META_AD_ACCOUNT_ID  conta de anúncios, com ou sem o prefixo act_ (padrão: act_1545616483609687)
 *   META_API_VERSION    versão da Marketing API (padrão: v25.0)
 *   RADAR_OUT           caminho do arquivo gerado (padrão: public/data.json)
 *
 * Sem dependências: só Node 20+ (fetch nativo).
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULTS = {
  account: 'act_1545616483609687',
  accountName: 'Henrique',
  version: 'v25.0',
  out: 'public/data.json',
  timezone: 'America/Sao_Paulo',
};

// Moedas que a Meta representa sem centavos (orçamentos vêm na unidade inteira).
const ZERO_DECIMAL = new Set(['CLP', 'COP', 'HUF', 'ISK', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);

/* ------------------------------------------------------------------ datas */
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Data civil (ano, mês, dia) de um instante, no fuso horário da conta. */
export function localYMD(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12

/** Mesmo recorte da página: mês atual até hoje, comparado com os mesmos dias do mês anterior. */
export function periodRange(now, timezone) {
  const { y, m, d } = localYMD(now, timezone);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const today = isoOf(y, m, d);
  return {
    key: 'this_month',
    since: isoOf(y, m, 1),
    until: today,
    cSince: isoOf(py, pm, 1),
    cUntil: isoOf(py, pm, Math.min(d, daysInMonth(py, pm))),
    cLabel: 'mesmos dias do mês anterior',
    today,
  };
}

/** ISO 8601 com o deslocamento do fuso da conta, ex.: 2026-09-17T09:05:00-03:00 */
export function isoWithOffset(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  let off = get('timeZoneName').replace('GMT', '').replace('UTC', '');
  if (!off) off = '+00:00';
  else if (/^[+-]\d{1,2}$/.test(off)) off = off.replace(/^([+-])(\d)$/, '$10$2') + ':00';
  else if (/^[+-]\d:\d{2}$/.test(off)) off = off.replace(/^([+-])/, '$10');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${off}`;
}

/* ------------------------------------------------------------------ cliente da Graph API */
export class GraphError extends Error {
  constructor(message, info) { super(message); this.name = 'GraphError'; Object.assign(this, info); }
}

export function makeClient({ token, version = DEFAULTS.version, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  const base = `https://graph.facebook.com/${version}`;

  async function call(pathname, params = {}) {
    const url = new URL(base + '/' + pathname.replace(/^\//, ''));
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    url.searchParams.set('access_token', token);
    for (let attempt = 0; ; attempt++) {
      let res, body;
      try {
        res = await fetchImpl(url);
        body = await res.json().catch(() => ({}));
      } catch (e) {
        if (attempt < 3) { log(`rede: ${e.message} — tentando de novo`); await sleep(1500 * (attempt + 1)); continue; }
        throw new GraphError(`Falha de rede ao chamar a Meta: ${e.message}`, { transient: true });
      }
      if (res.ok && !body.error) return body;
      const err = body.error || {};
      const code = Number(err.code);
      const transient = res.status >= 500 || [1, 2, 4, 17, 32, 613].includes(code);
      const info = { status: res.status, code, subcode: err.error_subcode, type: err.type, fbtrace: err.fbtrace_id, transient };
      if (transient && attempt < 3) { log(`Meta respondeu ${res.status}/${code} (${err.message}) — tentando de novo`); await sleep(2500 * (attempt + 1)); continue; }
      let hint = '';
      if (code === 190) hint = ' O token expirou ou foi revogado: gere um token novo no Business Manager (Usuários do sistema) e atualize o segredo META_ACCESS_TOKEN no GitHub.';
      else if (code === 100 && /nonexisting field|does not exist/i.test(err.message || '')) hint = ' Um campo pedido não existe nesta versão da API — verifique META_API_VERSION.';
      else if (code === 200 || code === 10 || code === 294) hint = ' O token não tem permissão nesta conta: confira se o usuário do sistema tem a conta de anúncios atribuída e a permissão ads_read.';
      throw new GraphError(`Meta API ${res.status} (código ${code}): ${err.message || 'erro desconhecido'}.${hint}`, info);
    }
  }

  /** Percorre todas as páginas de uma listagem. */
  async function all(pathname, params = {}) {
    const out = [];
    let page = await call(pathname, { limit: 500, ...params });
    for (;;) {
      if (Array.isArray(page.data)) out.push(...page.data);
      const next = page.paging && page.paging.cursors && page.paging.cursors.after && page.paging.next ? page.paging.cursors.after : null;
      if (!next) break;
      page = await call(pathname, { limit: 500, ...params, after: next });
    }
    return out;
  }

  return { call, all };
}

/* ------------------------------------------------------------------ normalização */
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;

/** { action_type: valor } a partir da lista `actions` da Insights API. */
export function actionsMap(list) {
  const out = {};
  if (Array.isArray(list)) for (const a of list) if (a && a.action_type) out[a.action_type] = num(a.value);
  return out;
}

/** Destino da campanha pelo nome — a mesma regra da página, usada só para rotular o "resultado". */
function destOf(name, extra = {}) {
  const n = name || '';
  if (/formul[aá]rio|\[\s*leads?\s*\]|lead ?gen/i.test(n)) return 'Formulário';
  if (/whats/i.test(n)) return 'WhatsApp';
  if (extra.optimization_goal === 'CONVERSATIONS' || /WHATSAPP|MESSENGER|INSTAGRAM_DIRECT/.test(extra.destination_type || '')) return 'WhatsApp';
  if (/LEAD/.test(extra.optimization_goal || '') || extra.objective === 'OUTCOME_LEADS') return 'Formulário';
  return 'Outros';
}

export function deliveryOf(effectiveStatus) {
  const s = String(effectiveStatus || '').toUpperCase();
  let status = 'inactive';
  if (s === 'ACTIVE') status = 'active';
  else if (s === 'WITH_ISSUES' || s === 'DISAPPROVED') status = 'error';
  else if (s === 'IN_PROCESS' || s === 'PENDING_REVIEW' || s === 'PREAPPROVED' || s === 'PENDING_BILLING_INFO') status = 'pending';
  else if (s === 'ARCHIVED' || s === 'DELETED' || s === 'COMPLETED') status = 'completed';
  return { status, substatuses: [] };
}

export function budgetOf(minor, currency) {
  if (minor == null || minor === '') return 0;
  const n = num(minor);
  return ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? n : round2(n / 100);
}

/** Métricas de uma linha da Insights API, nos nomes que a página entende. */
export function metricsOf(row, dest) {
  const spend = round2(num(row && row.spend));
  const acts = actionsMap(row && row.actions);
  const leads = acts['lead'] || 0;
  const conversations = acts['onsite_conversion.messaging_conversation_started_7d'] || 0;
  const impressions = num(row && row.impressions), reach = num(row && row.reach), clicks = num(row && row.inline_link_clicks);
  const out = {
    amount_spent: spend, impressions, reach,
    frequency: row && row.frequency != null ? round2(num(row.frequency)) : (reach ? round2(impressions / reach) : 0),
    cpm: row && row.cpm != null ? round2(num(row.cpm)) : (impressions ? round2(spend / impressions * 1000) : 0),
    ctr: row && row.ctr != null ? round2(num(row.ctr)) : (impressions ? round2(clicks / impressions * 100) : 0),
    link_click: clicks,
    lead: leads,
    conversations,
    cost_per_lead: leads ? round2(spend / leads) : null,
    'cost_per_action_type:onsite_conversion.messaging_conversation_started_7d': conversations ? round2(spend / conversations) : null,
    results: null, cost_per_result: null,
  };
  // "Resultado" da linha, no espírito da coluna Resultados do Gerenciador
  let ind = null, val = 0;
  if (dest === 'WhatsApp' || (dest !== 'Formulário' && conversations && !leads)) { ind = 'actions:onsite_conversion.messaging_conversation_started_7d'; val = conversations; }
  else if (dest === 'Formulário' || leads) { ind = 'actions:lead'; val = leads; }
  else if (clicks) { ind = 'actions:link_click'; val = clicks; }
  if (ind) { out.results = { indicator: ind, values: [{ value: val }] }; out.cost_per_result = { value: val ? round2(spend / val) : null }; }
  return out;
}

const thruplays = (list) => Array.isArray(list) ? list.reduce((t, a) => t + num(a && a.value), 0) : 0;

/**
 * Junta entidades (campanhas/conjuntos/anúncios) com as linhas de Insights do período.
 * Entidades sem gasto continuam na lista (com métricas zeradas); linhas de Insights sem entidade
 * (itens arquivados/apagados que ainda gastaram no período) viram entidades sintéticas.
 */
export function joinLevel({ level, entities, insights, currency, campaignsById = {}, adsetsById = {} }) {
  const idField = level === 'campaign' ? 'campaign_id' : level === 'adset' ? 'adset_id' : 'ad_id';
  const nameField = level === 'campaign' ? 'campaign_name' : level === 'adset' ? 'adset_name' : 'ad_name';
  const byId = new Map();
  for (const e of entities) byId.set(String(e.id), { e, row: null });
  for (const r of insights) {
    const id = String(r[idField]);
    if (byId.has(id)) byId.get(id).row = r;
    else byId.set(id, { e: { id, name: r[nameField], effective_status: 'ARCHIVED', campaign_id: r.campaign_id, adset_id: r.adset_id, _synthetic: true }, row: r });
  }
  const out = [];
  for (const { e, row } of byId.values()) {
    const camp = campaignsById[String(e.campaign_id || '')] || null;
    const adset = adsetsById[String(e.adset_id || '')] || null;
    const extra = level === 'campaign' ? { objective: e.objective } : level === 'adset' ? { optimization_goal: e.optimization_goal, destination_type: e.destination_type }
      : { optimization_goal: adset && adset.optimization_goal, destination_type: adset && adset.destination_type };
    const dest = destOf(level === 'campaign' ? e.name : (camp ? camp.name : e.name), extra);
    const ent = {
      id: String(e.id),
      name: e.name || '',
      effective_status: e.effective_status || '',
      delivery: deliveryOf(e.effective_status),
      ...metricsOf(row, dest),
    };
    if (level === 'campaign') {
      ent.objective = e.objective || '';
      ent.daily_budget = budgetOf(e.daily_budget, currency);
    } else if (level === 'adset') {
      ent.campaign_id = String(e.campaign_id || '');
      ent.campaign_name = camp ? camp.name : (row ? row.campaign_name || '' : '');
      ent.daily_budget = budgetOf(e.daily_budget, currency);
      ent.optimization_goal = e.optimization_goal || '';
      ent.destination_type = e.destination_type || '';
      const ls = e.learning_stage_info && e.learning_stage_info.status;
      ent.delivery_sub_status = ls === 'LEARNING' ? 'LEARNING' : ls === 'FAIL' ? 'LEARNING_LIMITED' : '';
    } else {
      ent.adset_id = String(e.adset_id || '');
      ent.adset_name = adset ? adset.name : (row ? row.adset_name || '' : '');
      ent.campaign_id = String(e.campaign_id || (adset && adset.campaign_id) || '');
      ent.campaign_name = camp ? camp.name : (row ? row.campaign_name || '' : '');
      ent.video_thruplay_watched_actions = thruplays(row && row.video_thruplay_watched_actions);
    }
    out.push(ent);
  }
  return out;
}

/** Linhas diárias (ou do período de comparação) por campanha. */
export function dailyRows(insights, campaignsById) {
  return insights.map((r) => {
    const id = String(r.campaign_id); const camp = campaignsById[id];
    const name = camp ? camp.name : r.campaign_name || '';
    const dest = destOf(name, camp ? { objective: camp.objective } : {});
    const m = metricsOf(r, dest);
    return { id, name, date_start: r.date_start, date_stop: r.date_stop, amount_spent: m.amount_spent, impressions: m.impressions, reach: m.reach, link_click: m.link_click, lead: m.lead, conversations: m.conversations, cost_per_lead: m.cost_per_lead, 'cost_per_action_type:onsite_conversion.messaging_conversation_started_7d': m['cost_per_action_type:onsite_conversion.messaging_conversation_started_7d'], results: m.results };
  });
}

/** Linhas por posicionamento (Facebook x Instagram), por campanha. */
export function platRows(insights, campaignsById) {
  return insights.map((r) => {
    const id = String(r.campaign_id); const camp = campaignsById[id];
    const name = camp ? camp.name : r.campaign_name || '';
    const dest = destOf(name, camp ? { objective: camp.objective } : {});
    const m = metricsOf(r, dest);
    return { id, name, publisher_platform: r.publisher_platform || '', amount_spent: m.amount_spent, impressions: m.impressions, reach: m.reach, link_click: m.link_click, lead: m.lead, cost_per_lead: m.cost_per_lead, results: m.results };
  });
}

/* ------------------------------------------------------------------ coleta */
const INSIGHT_BASE = ['spend', 'impressions', 'reach', 'frequency', 'cpm', 'ctr', 'inline_link_clicks', 'actions'];
const FIELDS = {
  campaign: ['campaign_id', 'campaign_name', ...INSIGHT_BASE],
  adset: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', ...INSIGHT_BASE],
  ad: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', ...INSIGHT_BASE, 'video_thruplay_watched_actions'],
  daily: ['campaign_id', 'campaign_name', 'spend', 'impressions', 'reach', 'inline_link_clicks', 'actions'],
};

export async function collect({ client, account, now = new Date(), log = () => {} }) {
  const acct = await client.call(account, { fields: 'name,currency,timezone_name,account_id' });
  const timezone = acct.timezone_name || DEFAULTS.timezone;
  const currency = acct.currency || 'BRL';
  const range = periodRange(now, timezone);
  log(`conta ${acct.name} (${acct.account_id}) · ${currency} · ${timezone} · período ${range.since} a ${range.until}`);

  const tr = (since, until) => ({ since, until });
  const insights = (level, since, until, extra = {}) => client.all(`${account}/insights`, {
    level, fields: FIELDS[level === 'daily' ? 'daily' : level].join(','), time_range: tr(since, until),
    use_account_attribution_setting: true, ...extra,
  });

  const [campaignsE, adsetsE, adsE] = await Promise.all([
    client.all(`${account}/campaigns`, { fields: 'id,name,objective,effective_status,daily_budget,lifetime_budget' }),
    client.all(`${account}/adsets`, { fields: 'id,name,campaign_id,effective_status,daily_budget,lifetime_budget,optimization_goal,destination_type,learning_stage_info' }),
    client.all(`${account}/ads`, { fields: 'id,name,adset_id,campaign_id,effective_status' }),
  ]);
  log(`entidades: ${campaignsE.length} campanhas · ${adsetsE.length} conjuntos · ${adsE.length} anúncios`);

  const [campI, adsetI, adI, dailyI, prevI, platI] = await Promise.all([
    insights('campaign', range.since, range.until),
    insights('adset', range.since, range.until),
    insights('ad', range.since, range.until),
    client.all(`${account}/insights`, { level: 'campaign', fields: FIELDS.daily.join(','), time_range: tr(range.since, range.until), time_increment: 1, use_account_attribution_setting: true }),
    client.all(`${account}/insights`, { level: 'campaign', fields: FIELDS.daily.join(','), time_range: tr(range.cSince, range.cUntil), use_account_attribution_setting: true }),
    client.all(`${account}/insights`, { level: 'campaign', fields: FIELDS.daily.join(','), time_range: tr(range.since, range.until), breakdowns: 'publisher_platform', use_account_attribution_setting: true }),
  ]);
  log(`insights: ${campI.length} campanhas · ${adsetI.length} conjuntos · ${adI.length} anúncios · ${dailyI.length} linhas diárias · ${prevI.length} do mês anterior · ${platI.length} por posicionamento`);

  const campaignsById = Object.fromEntries(campaignsE.map((c) => [String(c.id), c]));
  const adsetsById = Object.fromEntries(adsetsE.map((a) => [String(a.id), a]));
  const campaigns = joinLevel({ level: 'campaign', entities: campaignsE, insights: campI, currency });
  const adsets = joinLevel({ level: 'adset', entities: adsetsE, insights: adsetI, currency, campaignsById });
  const ads = joinLevel({ level: 'ad', entities: adsE, insights: adI, currency, campaignsById, adsetsById });

  return {
    version: 1,
    generatedAt: isoWithOffset(now, timezone),
    source: 'Meta Marketing API ' + (client.version || ''),
    account: { id: String(acct.account_id || account.replace(/^act_/, '')), name: acct.name || DEFAULTS.accountName, currency, timezone },
    range,
    campaigns, adsets, ads,
    daily: dailyRows(dailyI, campaignsById),
    prev: dailyRows(prevI, campaignsById),
    plat: platRows(platI, campaignsById),
    today: null,
  };
}

/* ------------------------------------------------------------------ execução */
async function main() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) { console.error('Falta a variável META_ACCESS_TOKEN.'); process.exit(2); }
  const account = 'act_' + String(process.env.META_AD_ACCOUNT_ID || DEFAULTS.account).replace(/^act_/, '');
  const version = process.env.META_API_VERSION || DEFAULTS.version;
  const out = process.env.RADAR_OUT || DEFAULTS.out;
  const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);
  const client = makeClient({ token, version, log });
  client.version = version;
  const data = await collect({ client, account, log });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(data));
  const spend = data.campaigns.reduce((t, c) => t + c.amount_spent, 0);
  log(`gravado ${out} · investimento do período ${data.account.currency} ${spend.toFixed(2)} · gerado em ${data.generatedAt}`);
}

if (process.argv[1] && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
